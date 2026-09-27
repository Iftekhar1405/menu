-- Running orders.
--
-- A table that orders again shortly after being served is mid-meal, not a new
-- arrival. This marks that case at the moment the order is created, so the
-- board can put it first.
--
-- The decision is made inside place_table_round rather than by the API after
-- it returns. The alternative — place the round, then work out in a second
-- statement whether it was a return and update the row — leaves the order
-- observable in the wrong state for as long as that round trip takes, and the
-- board poll, the staff notification and the realtime ping all read it in
-- that window.

-- ── Settings ─────────────────────────────────────────────────────────────

ALTER TABLE businesses
  ADD COLUMN running_order_enabled     boolean NOT NULL DEFAULT true,
  -- Roughly a starters-then-mains gap. The bounds keep the setting
  -- meaningful: under 5 minutes nothing ever qualifies, over 180 everything
  -- does, and a flag that fires on every table is not a priority signal.
  ADD COLUMN running_order_window_mins integer NOT NULL DEFAULT 45
    CONSTRAINT businesses_running_window_range
    CHECK (running_order_window_mins BETWEEN 5 AND 180);

-- ── The flag ─────────────────────────────────────────────────────────────

-- Stored, not recomputed on read. Partly because the board polls every five
-- seconds and a time-window predicate per order per poll is work for nothing,
-- but mainly because this is a fact about what was true when the order
-- arrived: shortening the window tomorrow must not un-flag an order that was
-- a genuine return today.
--
-- No backfill. We do not know what last week's owner would have wanted
-- flagged, and guessing would hang stale badges on orders already served.
ALTER TABLE orders
  ADD COLUMN is_running boolean NOT NULL DEFAULT false;

-- ── Placement decides it ─────────────────────────────────────────────────

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
  v_running_on  bool;
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
  PERFORM pg_advisory_xact_lock(hashtext(p_table_id::text));

  SELECT id INTO v_order_id
  FROM orders
  WHERE table_id = p_table_id AND status IN ('placed','preparing','ready');

  IF FOUND THEN
    SELECT COALESCE(MAX(batch), 0) + 1 INTO v_batch
    FROM order_items WHERE order_id = v_order_id;
  ELSE
    -- A new order, which is the only case that can be a return.
    --
    -- Completed only: a cancelled order was never served, so a table
    -- reordering after one is retrying rather than returning, and flagging
    -- them would jump a table that has eaten nothing ahead of tables actually
    -- waiting on a second round.
    --
    -- Measured from completed_at so the window starts when the food went
    -- out; measuring from placed_at would let a slow kitchen shorten its own
    -- window. Not constrained to the business day either — a table served at
    -- 11:52pm that orders again at 12:05am is the same party.
    SELECT running_order_enabled, running_order_window_mins
      INTO v_running_on, v_window
      FROM businesses WHERE id = p_business_id;

    IF COALESCE(v_running_on, false) THEN
      SELECT EXISTS (
        SELECT 1 FROM orders
         WHERE table_id = p_table_id
           AND status = 'completed'
           AND completed_at IS NOT NULL
           AND completed_at > now() - make_interval(mins => v_window)
      ) INTO v_is_running;
    END IF;

    v_daily := next_daily_number(p_business_id, v_day);
    v_batch := 1;
    INSERT INTO orders (id, business_id, table_id, status, business_day, daily_number, placed_at, updated_at, is_running)
    VALUES (gen_random_uuid(), p_business_id, p_table_id, 'placed', v_day, v_daily, now(), now(), v_is_running)
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

    -- name, variant and price are copied in as they are right now. A price
    -- change later must not alter what this table is charged.
    INSERT INTO order_items
      (id, order_id, business_id, menu_item_id, name_snapshot, variant_snapshot,
       unit_price, quantity, batch, created_at)
    VALUES
      (gen_random_uuid(), v_order_id, p_business_id, v_item.id, v_item.name,
       v_variant_name, v_price, v_quantity, v_batch, now());
  END LOOP;

  UPDATE orders SET updated_at = now() WHERE id = v_order_id;

  -- Merged in here rather than added to get_table_order, which is shared with
  -- the diner's own polling and is rewritten by other migrations. The flag is
  -- staff-facing: the notification written from this payload has to say
  -- "Ordered again" rather than "New order", and the diner is deliberately
  -- told nothing — a priority we have not promised them is worse than
  -- silence. Read back from the row so an appended round reports the flag the
  -- order actually carries.
  RETURN get_table_order(p_table_id) || jsonb_build_object(
    'isRunning',
    COALESCE((SELECT is_running FROM orders WHERE id = v_order_id), false)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION place_table_round(uuid, uuid, jsonb) TO menu_app;
