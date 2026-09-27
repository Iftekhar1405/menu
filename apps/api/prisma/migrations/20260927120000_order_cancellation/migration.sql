-- Cancelling an order, or part of one, from the diner's phone.
--
-- The shape worth explaining is what this does NOT touch. Cancelling
-- decrements `order_items.quantity`, and a line cancelled in full is deleted.
-- So `generate_bill`, the kitchen board, the round summariser and every
-- report keep reading `quantity` and are correct about cancelled food without
-- any of them being taught what a cancellation is. The alternative — a status
-- column every reader must remember to filter — makes billing a cancelled
-- dish the failure you get from forgetting one `WHERE`, and that is the one
-- failure this must not have.
--
-- The cost is that the history needs somewhere else to live, which is the
-- ledger below. It carries its own name, variant and price so it still reads
-- once the line it came from is gone.


-- ── Reasons ──────────────────────────────────────────────────────────────

CREATE TYPE "CancellationReason" AS ENUM
  ('mistake', 'changed_mind', 'wrong_item', 'too_slow', 'other');

-- Only `diner` is written today. `staff` exists because the board's own
-- Cancel button will eventually record a reason too, and a ledger that
-- cannot say who cancelled would have to be migrated on that day.
CREATE TYPE "CancelledBy" AS ENUM ('diner', 'staff');


-- ── The owner's policy ───────────────────────────────────────────────────

ALTER TABLE "businesses"
  ADD COLUMN "cancellation_enabled"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cancellation_window_mins"   INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "cancellation_statuses"      "OrderStatus"[] NOT NULL DEFAULT ARRAY['placed']::"OrderStatus"[],
  ADD COLUMN "cancellation_items_enabled" BOOLEAN NOT NULL DEFAULT true;

-- Belt and braces against a bad PATCH: the API validates this too, but a
-- window of zero would silently mean "never", which is not what an owner who
-- typed zero is trying to say.
ALTER TABLE "businesses"
  ADD CONSTRAINT "businesses_cancellation_window_range"
  CHECK ("cancellation_window_mins" BETWEEN 1 AND 120);


-- ── The ledger ───────────────────────────────────────────────────────────

CREATE TABLE "order_item_cancellations" (
    "id"               UUID NOT NULL,
    "business_id"      UUID NOT NULL,
    "order_id"         UUID NOT NULL,
    -- Nulled, not deleted, when the line goes: the record of what was
    -- cancelled must outlive the line that was cancelled.
    "order_item_id"    UUID,
    "quantity"         INTEGER NOT NULL,
    "name_snapshot"    TEXT NOT NULL,
    "variant_snapshot" TEXT,
    "unit_price"       DECIMAL(10,2) NOT NULL,
    "reason"           "CancellationReason" NOT NULL,
    "remark"           TEXT,
    "cancelled_by"     "CancelledBy" NOT NULL DEFAULT 'diner',
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_cancellations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "order_item_cancellations_quantity_positive" CHECK ("quantity" > 0)
);

CREATE INDEX "order_item_cancellations_order_id_idx"
  ON "order_item_cancellations"("order_id");

-- The shape every report wants: this business, over a date range.
CREATE INDEX "order_item_cancellations_business_id_created_at_idx"
  ON "order_item_cancellations"("business_id", "created_at");

ALTER TABLE "order_item_cancellations"
  ADD CONSTRAINT "order_item_cancellations_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_item_cancellations"
  ADD CONSTRAINT "order_item_cancellations_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_item_cancellations"
  ADD CONSTRAINT "order_item_cancellations_order_item_id_fkey"
  FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Isolation ────────────────────────────────────────────────────────────

ALTER TABLE order_item_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_cancellations FORCE  ROW LEVEL SECURITY;

CREATE POLICY order_item_cancellations_owner ON order_item_cancellations
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON order_item_cancellations TO menu_app;


-- ── What the diner's screen is told ──────────────────────────────────────
--
-- Additive to get_table_order. The phone has to decide whether to draw a
-- Cancel control at all, and for how much longer — which means it needs the
-- owner's policy and a deadline per line, not just the order.
--
-- `serverNow` is returned alongside so the countdown is honest on a phone
-- whose clock is wrong. The deadlines below are advisory in exactly the same
-- way the button is: cancel_table_order re-checks every one of them against
-- its own clock, inside the transaction that does the writing.
CREATE OR REPLACE FUNCTION get_table_order(p_table_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id',          o.id,
    'status',      o.status,
    'dailyNumber', o.daily_number,
    'placedAt',    to_char(o.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'tableLabel',  t.label,
    'currency',    b.currency,
    'serverNow',   to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'cancellation', jsonb_build_object(
      -- Enabled here means "right now, for this order": the switch is on and
      -- the kitchen has not moved past a status the owner still allows.
      'enabled',      b.cancellation_enabled AND o.status = ANY (b.cancellation_statuses),
      'itemsEnabled', b.cancellation_items_enabled,
      'windowMins',   b.cancellation_window_mins
    ),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id',        i.id,
               'name',      i.name_snapshot,
               'variant',   i.variant_snapshot,
               'unitPrice', i.unit_price::text,
               'quantity',  i.quantity,
               'batch',     i.batch,
               -- Per line, from when that line was ordered. A round added at
               -- 8:40 must not hand the 8:10 round a fresh two minutes.
               'cancellableUntil', to_char(
                 (i.created_at + make_interval(mins => b.cancellation_window_mins))
                   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
             ) ORDER BY i.batch, i.created_at)
      FROM order_items i WHERE i.order_id = o.id
    ), '[]'::jsonb),
    'total', COALESCE((
      SELECT SUM(i.unit_price * i.quantity)::text
      FROM order_items i WHERE i.order_id = o.id
    ), '0')
  )
  FROM orders o
  JOIN tables t     ON t.id = o.table_id
  JOIN businesses b ON b.id = o.business_id
  WHERE o.table_id = p_table_id
    AND o.status IN ('placed', 'preparing', 'ready');
$$;


-- ── Cancelling ───────────────────────────────────────────────────────────
--
-- SECURITY DEFINER for the same reason place_table_round is: a diner has no
-- app.current_user_id, so orders and order_items are correctly invisible to
-- them under RLS.
--
-- Every rule the owner configured is enforced *here*, reading the settings
-- and the clock in the same transaction that does the writing. The phone is
-- told the deadlines so it can hide a button that would fail, but nothing it
-- sends is trusted: a request replayed a minute late, or aimed at another
-- table's line, is rejected on its own merits.
--
-- p_lines NULL cancels the whole order.
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
  v_live      int;
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

  IF NOT (v_order.status = ANY (v_biz.cancellation_statuses)) THEN
    RAISE EXCEPTION 'Your order has gone too far to cancel. Ask a member of staff.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_targets IS NOT NULL AND NOT v_biz.cancellation_items_enabled THEN
    RAISE EXCEPTION 'Single dishes cannot be cancelled here — only the whole order'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The whole order is every live line, in full. Expanded here rather than
  -- on the phone so a line added between the screen rendering and the tap is
  -- included rather than silently left behind.
  IF v_targets IS NULL THEN
    SELECT COALESCE(
             jsonb_agg(jsonb_build_object('orderItemId', id, 'quantity', quantity)),
             '[]'::jsonb)
      INTO v_targets
    FROM order_items WHERE order_id = v_order.id;
  END IF;

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

    v_cancelled := v_cancelled || jsonb_build_object(
      'name',      v_item.name_snapshot,
      'variant',   v_item.variant_snapshot,
      'quantity',  v_qty,
      'unitPrice', v_item.unit_price::text
    );
  END LOOP;

  SELECT COUNT(*) INTO v_live FROM order_items WHERE order_id = v_order.id;

  -- An order with nothing left in it is cancelled, not left open and empty.
  -- The table can order again straight away: place_table_round finds no open
  -- order and starts a fresh one.
  IF v_live = 0 THEN
    UPDATE orders
      SET status = 'cancelled', completed_at = now(), updated_at = now()
      WHERE id = v_order.id;
  ELSE
    UPDATE orders SET updated_at = now() WHERE id = v_order.id;
  END IF;

  RETURN jsonb_build_object(
    'orderId',        v_order.id,
    'orderCancelled', v_live = 0,
    'dailyNumber',    v_order.daily_number,
    'tableLabel',     (SELECT label FROM tables WHERE id = p_table_id),
    'currency',       v_biz.currency,
    'reason',         v_reason::text,
    'remark',         v_remark,
    'lines',          v_cancelled,
    -- Null once the order itself is cancelled, which is exactly what the
    -- diner's screen already knows how to render.
    'order',          get_table_order(p_table_id)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_table_order(uuid, jsonb, text, text) TO menu_app;
