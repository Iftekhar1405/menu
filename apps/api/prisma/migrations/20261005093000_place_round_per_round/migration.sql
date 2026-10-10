-- Rounds stop dragging each other backwards.
--
-- The old function ended every new round with
--   UPDATE orders SET status = 'placed'
-- so a table whose biryani was already ready was thrown back to New because
-- someone ordered a chai. Now the round carries its own status and the order's
-- is derived, so the reset is not only unnecessary, it is wrong.

CREATE OR REPLACE FUNCTION place_table_round(
  p_table_id    uuid,
  p_business_id uuid,
  p_lines       jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id    uuid;
  v_round_id    uuid;
  v_seq         int;
  v_kot         int;
  v_day         date := CURRENT_DATE;
  v_daily       int;
  v_line        jsonb;
  v_item        record;
  v_variant     record;
  v_price       numeric(10,2);
  v_variant_name text;
  v_quantity    int;
  v_active      bool;
  v_running_enabled bool;
  v_window      int;
  v_is_running  bool := false;
BEGIN
  IF jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Add something to the order first' USING ERRCODE = 'check_violation';
  END IF;

  SELECT is_active INTO v_active
  FROM tables WHERE id = p_table_id AND business_id = p_business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That table no longer exists' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'This table is no longer taking orders' USING ERRCODE = 'check_violation';
  END IF;

  -- Serialise rounds for this table only. Other tables are unaffected.
  -- Everything below that reads a MAX to allocate a number depends on this.
  PERFORM pg_advisory_xact_lock(hashtext(p_table_id::text));

  -- WARNING: the open-status list here is one of the hand-written copies.
  -- See apps/api/src/orders/transitions.ts.
  SELECT id INTO v_order_id
  FROM orders
  WHERE table_id = p_table_id
    AND status IN ('placed','accepted','preparing','ready');

  IF FOUND THEN
    SELECT COALESCE(MAX(seq), 0) + 1 INTO v_seq
    FROM order_rounds WHERE order_id = v_order_id;

    -- Deliberately absent: the UPDATE that used to reset orders.status to
    -- 'placed'. The new round carries its own status, and the trigger from
    -- 20261005091000_derive_order_status recomputes orders.status from the
    -- rounds the moment the round below is inserted. Writing it here would
    -- be a second, conflicting source of truth.

    -- Carry the running flag so notifications can say "Ordered again" on
    -- later rounds too — the table came back, which is always worth noting.
    SELECT is_running INTO v_is_running FROM orders WHERE id = v_order_id;

  ELSE
    SELECT running_order_enabled, running_order_window_mins
      INTO v_running_enabled, v_window
      FROM businesses WHERE id = p_business_id;

    IF v_running_enabled THEN
      SELECT true INTO v_is_running
        FROM orders
       WHERE table_id = p_table_id
         AND status = 'completed'
         AND completed_at IS NOT NULL
         AND completed_at > now() - make_interval(mins => v_window)
       LIMIT 1;
    END IF;

    v_daily := next_daily_number(p_business_id, v_day);
    v_seq   := 1;
    INSERT INTO orders (id, business_id, table_id, status, business_day, daily_number, is_running, placed_at, updated_at)
    VALUES (gen_random_uuid(), p_business_id, p_table_id, 'placed', v_day, v_daily, COALESCE(v_is_running, false), now(), now())
    RETURNING id INTO v_order_id;
  END IF;

  -- Safe as a plain MAX because the advisory lock above serialises every
  -- round for this table, and KOT numbers are only ever allocated here.
  v_kot := next_kot_number(p_business_id, v_day);

  INSERT INTO order_rounds
    (id, business_id, order_id, seq, business_day, kot_number, status, placed_at)
  VALUES
    (gen_random_uuid(), p_business_id, v_order_id, v_seq, v_day, v_kot, 'placed', now())
  RETURNING id INTO v_round_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_quantity := (v_line->>'quantity')::int;
    IF v_quantity IS NULL OR v_quantity < 1 OR v_quantity > 99 THEN
      RAISE EXCEPTION 'Choose a quantity between 1 and 99' USING ERRCODE = 'check_violation';
    END IF;

    SELECT id, name, price INTO v_item
    FROM menu_items
    WHERE id = (v_line->>'itemId')::uuid
      AND business_id = p_business_id
      AND is_available;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'One of those dishes is no longer available'
        USING ERRCODE = 'check_violation';
    END IF;

    v_variant_name := NULL;

    IF v_line->>'variantId' IS NOT NULL THEN
      SELECT name, price INTO v_variant
      FROM menu_item_variants
      WHERE id = (v_line->>'variantId')::uuid AND item_id = v_item.id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'That size is no longer available' USING ERRCODE = 'check_violation';
      END IF;

      v_price := v_variant.price;
      v_variant_name := v_variant.name;
    ELSE
      IF v_item.price IS NULL THEN
        RAISE EXCEPTION 'Choose a size for %', v_item.name USING ERRCODE = 'check_violation';
      END IF;
      v_price := v_item.price;
    END IF;

    INSERT INTO order_items
      (id, order_id, business_id, menu_item_id, name_snapshot, variant_snapshot,
       unit_price, quantity, round_id, created_at)
    VALUES
      (gen_random_uuid(), v_order_id, p_business_id, v_item.id, v_item.name,
       v_variant_name, v_price, v_quantity, v_round_id, now());
  END LOOP;

  -- Log the round. There is no AFTER INSERT event trigger on order_rounds
  -- precisely so that this stays the one place a round's arrival is logged,
  -- with the item list the notification service reads.
  --
  -- is_running is included so that service can say "Ordered again" on every
  -- round from a returning table, not just the first one.
  --
  -- 'batch' is kept alongside 'seq', set to the same value, for one release:
  -- NotificationsService and the diner's timeline still read it, and they
  -- move over in Task 11.
  INSERT INTO order_events (order_id, business_id, round_id, kind, data)
  SELECT
    v_order_id,
    p_business_id,
    v_round_id,
    CASE WHEN v_seq = 1 THEN 'placed' ELSE 'round_added' END,
    jsonb_build_object(
      'seq', v_seq,
      'batch', v_seq,
      'kotNumber', v_kot,
      'isRunning', COALESCE(v_is_running, false),
      'items', COALESCE(jsonb_agg(jsonb_build_object(
        'name', CASE WHEN i.variant_snapshot IS NULL
                     THEN i.name_snapshot
                     ELSE i.name_snapshot || ' (' || i.variant_snapshot || ')' END,
        'quantity', i.quantity
      ) ORDER BY i.created_at), '[]'::jsonb)
    )
  FROM order_items i
  WHERE i.round_id = v_round_id;

  UPDATE orders SET updated_at = now() WHERE id = v_order_id;

  RETURN get_table_order(p_table_id);
END;
$$;


-- get_table_order: stop reading the dropped order_items.batch column.
--
-- 20261005090000_order_rounds dropped that column, which left this function
-- raising `column i.batch does not exist` on its first call — and
-- place_table_round above returns it, so no diner could place an order at
-- all until this is repaired. The payload is deliberately unchanged: the
-- same 'batch' key with the same meaning, now read off the round that owns
-- the item instead of off the item. Task 6 adds the `rounds` array the
-- boards will actually render from; this is only what Task 5 cannot run
-- without.
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
    'isRunning',   o.is_running,
    'dailyNumber', o.daily_number,
    'placedAt',    to_char(o.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'tableLabel',  t.label,
    'currency',    b.currency,
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id',       i.id,
               'name',     i.name_snapshot,
               'variant',  i.variant_snapshot,
               'unitPrice', i.unit_price::text,
               'quantity', i.quantity,
               'batch',    r.seq
             ) ORDER BY r.seq, i.created_at)
      FROM order_items i
      JOIN order_rounds r ON r.id = i.round_id
      WHERE i.order_id = o.id
    ), '[]'::jsonb),
    'events', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id',   e.id,
               'kind', e.kind,
               'at',   to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'data', e.data
             ) ORDER BY e.id)
      FROM order_events e WHERE e.order_id = o.id
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
    AND (
      -- Open orders: always return.
      o.status IN ('placed', 'accepted', 'preparing', 'ready')
      OR
      -- Recently closed: a diner re-scanning after their order was served
      -- should see their receipt, not an empty screen. 2h is long enough to
      -- cover a meal; after that the table has almost certainly turned over.
      (o.status IN ('completed', 'cancelled')
       AND o.placed_at > now() - interval '2 hours')
    )
  ORDER BY
    -- Open orders first, then most recent. A table may have a completed order
    -- from earlier and a new open one; the open one is always what is wanted.
    CASE WHEN o.status IN ('placed','accepted','preparing','ready') THEN 0 ELSE 1 END,
    o.placed_at DESC
  LIMIT 1;
$$;
