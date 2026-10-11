-- Cancellation asks the round, not the order.
--
-- Two things changed under this function's feet, and both make the order's
-- own status the wrong thing to ask.
--
-- The first is the owner's policy check. orders.status is now derived as the
-- *least advanced* live round (20261005091000_derive_order_status), so a
-- table holding a ready biryani and a chai that went in thirty seconds ago
-- reads 'placed'. An owner who allows cancelling only at 'placed' is
-- therefore telling this function that the biryani on the pass may be called
-- back. It may not. The round knows what state it is in; the order, by
-- construction, only knows about its least advanced one. So the check moves
-- inside the loop and asks the round each line belongs to.
--
-- Which states count as cancellable is untouched: the list is still the
-- owner's `businesses.cancellation_statuses`, validated against
-- CANCELLABLE_STATUSES ('placed', 'preparing', 'ready') in
-- packages/shared/src/schemas.ts. 'accepted' is absent from that list and
-- stays absent here — a diner still cannot cancel once the counter has taken
-- the order. That is a product decision, open separately, and not something
-- this refactor gets to make by accident.
--
-- That changes what "Cancel order" means, and the change is worth stating
-- rather than leaving to be inferred. It used to take the whole order down,
-- every line in it, because one order-level answer covered them all. It now
-- takes down the part that still qualifies: the p_lines IS NULL expansion
-- below selects only the lines whose own round is in the owner's list, and
-- the rest stay on the order. A table with a ready biryani and a fresh chai
-- who taps Cancel order loses the chai and keeps the biryani. Refusing the
-- whole thing instead would have been the other available reading, and it is
-- the wrong one: it leaves an owner who has turned cancellation_items_enabled
-- off with a dead button from the moment any round advances, which is most of
-- the service.
--
-- When nothing at all qualifies, the existing 'There is nothing left to
-- cancel' is what the diner is told — the same message an order with no lines
-- already produced, reused rather than reinvented.
--
-- The second is what happens to a round once its last dish goes. Cancelling
-- deletes order_items, so an emptied round would sit there live and empty:
-- a blank ticket on the pass, and an order pinned to that round's status for
-- ever, because the derivation still counts it among the live ones. The
-- emptied rounds are cancelled, and the hand-written
-- `UPDATE orders SET status = 'cancelled'` goes — the derivation trigger
-- takes the order down once its last round does, and two writers of one
-- column would only fight.
--
-- The open-order lookup below is deliberately NOT touched. It reads
-- ('placed', 'preparing', 'ready') and has never known about 'accepted',
-- which is the same omission as above seen from the other side. Widening it
-- here would change what diners may do, silently, inside a refactor. See the
-- warning in apps/api/src/orders/transitions.ts.
CREATE OR REPLACE FUNCTION cancel_table_order(
  p_table_id uuid,
  p_lines    jsonb,
  p_reason   text,
  p_remark   text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order     record;
  v_biz       record;
  v_line      jsonb;
  v_item      record;
  v_targets   jsonb := p_lines;
  v_qty       int;
  v_remark    text := NULLIF(btrim(COALESCE(p_remark, '')), '');
  v_reason    "CancellationReason";
  v_cancelled jsonb := '[]'::jsonb;
  v_round_status "OrderStatus";
  -- The rounds this call took something out of, so the sweep at the end
  -- considers those and nothing else.
  v_touched   uuid[] := '{}';
  v_order_cancelled boolean;
BEGIN
  BEGIN
    v_reason := p_reason::"CancellationReason";
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Choose a reason first' USING ERRCODE = 'check_violation';
  END;

  -- "Something else" is not an answer on its own, and an owner reading these
  -- back a week later needs it to be one.
  IF v_reason = 'other' AND v_remark IS NULL THEN
    RAISE EXCEPTION 'Tell us what happened' USING ERRCODE = 'check_violation';
  END IF;

  -- The same lock place_table_round takes. A cancellation and a new round
  -- arriving on one table at once would otherwise race over the same rows.
  PERFORM pg_advisory_xact_lock(hashtext(p_table_id::text));

  SELECT o.id, o.business_id, o.status, o.daily_number INTO v_order
  FROM orders o
  WHERE o.table_id = p_table_id
    AND o.status IN ('placed', 'preparing', 'ready')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'You have no open order' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT cancellation_enabled, cancellation_window_mins, cancellation_statuses,
         cancellation_items_enabled, currency
    INTO v_biz
  FROM businesses WHERE id = v_order.business_id;

  IF NOT v_biz.cancellation_enabled THEN
    RAISE EXCEPTION 'Orders here cannot be cancelled from your phone. Ask a member of staff.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Deliberately absent here: the check of v_order.status against
  -- v_biz.cancellation_statuses. It is per line now, in the loop below.

  IF v_targets IS NOT NULL AND NOT v_biz.cancellation_items_enabled THEN
    RAISE EXCEPTION 'Single dishes cannot be cancelled here — only the whole order'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The whole order is every line the owner's policy still reaches, in full.
  --
  -- Expanded here rather than on the phone so a line added between the screen
  -- rendering and the tap is included rather than silently left behind — and
  -- filtered here, by the same policy the loop below applies per line, so the
  -- one advanced round does not take the request down with it. Without the
  -- join this would expand to the biryani on the pass, hit the guard in the
  -- loop, and cancel nothing at all; the diner would be told their chai
  -- cannot go because of a dish they were not asking about.
  --
  -- The loop still re-checks each line. That is not redundant: it is the only
  -- check on the p_lines path, where the ids come from the phone.
  IF v_targets IS NULL THEN
    SELECT COALESCE(
             jsonb_agg(jsonb_build_object('orderItemId', i.id, 'quantity', i.quantity)),
             '[]'::jsonb)
      INTO v_targets
    FROM order_items i
    JOIN order_rounds r ON r.id = i.round_id
    WHERE i.order_id = v_order.id
      AND r.status = ANY (v_biz.cancellation_statuses);
  END IF;

  -- Reached by an order with no lines left, and now also by a whole-order
  -- cancel where every round has moved past the owner's list. Both are the
  -- same answer to the diner: there is nothing here you can still call back.
  IF jsonb_array_length(v_targets) = 0 THEN
    RAISE EXCEPTION 'There is nothing left to cancel' USING ERRCODE = 'check_violation';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(v_targets)
  LOOP
    v_qty := (v_line->>'quantity')::int;

    -- Scoped to this table's own open order, so an id lifted from elsewhere
    -- resolves to nothing.
    SELECT * INTO v_item
    FROM order_items
    WHERE id = (v_line->>'orderItemId')::uuid AND order_id = v_order.id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'That dish is no longer on your order'
        USING ERRCODE = 'check_violation';
    END IF;

    -- A diner may still call back a chai that has not been started while the
    -- biryani is being made. Asking the order would refuse both or allow
    -- both, and under the derived status it is the second of those: the chai
    -- drags the whole order back to 'placed' and takes the biryani with it.
    --
    -- Read without FOR UPDATE, deliberately. The kitchen takes the round's
    -- row lock first and then the order's, through the derivation trigger;
    -- this function already holds the order's, so locking the round here
    -- would complete a deadlock cycle and hand one of the two a 40P01. The
    -- cost of not locking is a kitchen accept landing in the microseconds
    -- between this read and the DELETE below, which cancels a dish the pass
    -- has just picked up — and the pass is told, because the cancellation
    -- notification goes out either way. A deadlock is the worse trade.
    SELECT status INTO v_round_status
    FROM order_rounds WHERE id = v_item.round_id;

    IF NOT (v_round_status = ANY (v_biz.cancellation_statuses)) THEN
      RAISE EXCEPTION '% has gone too far to cancel. Ask a member of staff.',
        v_item.name_snapshot USING ERRCODE = 'check_violation';
    END IF;

    IF v_qty IS NULL OR v_qty < 1 OR v_qty > v_item.quantity THEN
      RAISE EXCEPTION 'You cannot cancel more % than you ordered', v_item.name_snapshot
        USING ERRCODE = 'check_violation';
    END IF;

    IF now() > v_item.created_at + make_interval(mins => v_biz.cancellation_window_mins) THEN
      RAISE EXCEPTION 'The time to cancel % has passed. Ask a member of staff.',
        v_item.name_snapshot USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO order_item_cancellations
      (id, business_id, order_id, order_item_id, quantity, name_snapshot,
       variant_snapshot, unit_price, reason, remark, cancelled_by, created_at)
    VALUES
      (gen_random_uuid(), v_order.business_id, v_order.id, v_item.id, v_qty,
       v_item.name_snapshot, v_item.variant_snapshot, v_item.unit_price,
       v_reason, v_remark, 'diner', now());

    IF v_qty = v_item.quantity THEN
      DELETE FROM order_items WHERE id = v_item.id;
    ELSE
      UPDATE order_items SET quantity = quantity - v_qty WHERE id = v_item.id;
    END IF;

    v_touched := v_touched || v_item.round_id;

    v_cancelled := v_cancelled || jsonb_build_object(
      'name',      v_item.name_snapshot,
      'variant',   v_item.variant_snapshot,
      'quantity',  v_qty,
      'unitPrice', v_item.unit_price::text
    );
  END LOOP;

  -- A round with nothing left in it is cancelled, not left open and empty.
  --
  -- Only the rounds this call emptied are considered, which is what lets this
  -- be written without a copy of the open-status list: every round reached
  -- here cleared the policy check above, so it is live by construction. A
  -- `status IN (...)` filter would be a seventh hand-written copy of that
  -- list — see the warning in apps/api/src/orders/transitions.ts — and would
  -- drift as silently as the others.
  UPDATE order_rounds
     SET status = 'cancelled', completed_at = now()
   WHERE id = ANY (v_touched)
     AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.round_id = order_rounds.id);

  -- orders.status is deliberately not written. The UPDATE above fires the
  -- trigger from 20261005091000_derive_order_status, which takes the order to
  -- 'cancelled' once its last live round goes and leaves it on whichever
  -- rounds remain otherwise — including setting completed_at. The
  -- `UPDATE orders SET status = 'cancelled', completed_at = now()` this
  -- replaces would now be a second writer of the same column.
  --
  -- The table can order again straight away either way: place_table_round
  -- finds no open order and starts a fresh one.
  UPDATE orders SET updated_at = now() WHERE id = v_order.id;

  SELECT status = 'cancelled' INTO v_order_cancelled
  FROM orders WHERE id = v_order.id;

  RETURN jsonb_build_object(
    'orderId',        v_order.id,
    'orderCancelled', v_order_cancelled,
    'dailyNumber',    v_order.daily_number,
    'tableLabel',     (SELECT label FROM tables WHERE id = p_table_id),
    'currency',       v_biz.currency,
    'reason',         v_reason::text,
    'remark',         v_remark,
    'lines',          v_cancelled,
    -- The order as it now stands. Since 20261005093000_place_round_per_round
    -- this is still populated for a cancelled order, for two hours after it
    -- was placed, so the diner who re-scans sees what happened rather than an
    -- empty screen.
    'order',          get_table_order(p_table_id)
  );
END;
$$;
