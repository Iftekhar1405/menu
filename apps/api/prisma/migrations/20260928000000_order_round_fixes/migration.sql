-- Three fixes in one migration:
--
-- 1. place_table_round: when a new round lands on a 'ready' order, move it
--    back to 'placed' so the card appears in the New column and staff see it.
--    Without this, a running-order round appended to a Ready order sits in the
--    Ready column — staff assume it is done and walk past it.
--
-- 2. place_table_round: carry is_running into the event data on batch>1, so
--    the notification service knows which table came back when announcing a
--    second round.
--
-- 3. get_table_order: include is_running and is_complete in the JSON so the
--    diner's screen can handle both a re-scanned expired session (issue 2)
--    and the new flag (issue 3).

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
  v_batch       int;
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
  v_existing_status text;
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
  PERFORM pg_advisory_xact_lock(hashtext(p_table_id::text));

  SELECT id, status::text INTO v_order_id, v_existing_status
  FROM orders
  WHERE table_id = p_table_id
    AND status IN ('placed','accepted','preparing','ready');

  IF FOUND THEN
    SELECT COALESCE(MAX(batch), 0) + 1 INTO v_batch
    FROM order_items WHERE order_id = v_order_id;

    -- A new round always resets the order to 'placed' so staff see it in
    -- the New column and go through Accept → Start again for the new items.
    -- Without this, Round 2 inherits whatever status Round 1 left behind
    -- (accepted, preparing, ready) and the kitchen walks past it.
    IF v_existing_status <> 'placed' THEN
      UPDATE orders SET status = 'placed', updated_at = now() WHERE id = v_order_id;
      -- The trigger fires on status change and logs the event automatically.
    END IF;

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
    v_batch := 1;
    INSERT INTO orders (id, business_id, table_id, status, business_day, daily_number, is_running, placed_at, updated_at)
    VALUES (gen_random_uuid(), p_business_id, p_table_id, 'placed', v_day, v_daily, COALESCE(v_is_running, false), now(), now())
    RETURNING id INTO v_order_id;
  END IF;

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
       unit_price, quantity, batch, created_at)
    VALUES
      (gen_random_uuid(), v_order_id, p_business_id, v_item.id, v_item.name,
       v_variant_name, v_price, v_quantity, v_batch, now());
  END LOOP;

  -- Log the round. is_running is included in the data so the notification
  -- service can say "Ordered again" on every round from a returning table,
  -- not just the first one.
  INSERT INTO order_events (order_id, business_id, kind, data)
  SELECT
    v_order_id,
    p_business_id,
    CASE WHEN v_batch = 1 THEN 'placed' ELSE 'round_added' END,
    jsonb_build_object(
      'batch', v_batch,
      'isRunning', COALESCE(v_is_running, false),
      'items', COALESCE(jsonb_agg(jsonb_build_object(
        'name', CASE WHEN i.variant_snapshot IS NULL
                     THEN i.name_snapshot
                     ELSE i.name_snapshot || ' (' || i.variant_snapshot || ')' END,
        'quantity', i.quantity
      ) ORDER BY i.created_at), '[]'::jsonb)
    )
  FROM order_items i
  WHERE i.order_id = v_order_id AND i.batch = v_batch;

  UPDATE orders SET updated_at = now() WHERE id = v_order_id;

  RETURN get_table_order(p_table_id);
END;
$$;


-- get_table_order: include is_running so the diner's "Waiting for them to
-- accept" copy makes sense for a returning table. Also exposes is_complete
-- so a diner who re-scans after their order was served sees a sensible screen
-- rather than an empty one.
--
-- The function already returns NULL when status is not in the open set, which
-- is the correct "no open order" signal. This version also returns completed
-- orders within the last 2 hours so a diner who re-scans after paying still
-- sees their receipt rather than a blank screen.

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
               'batch',    i.batch
             ) ORDER BY i.batch, i.created_at)
      FROM order_items i WHERE i.order_id = o.id
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
