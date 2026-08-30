-- Placing a round, as one atomic operation.
--
-- A diner has no app.current_user_id, so every table they need — menu_items,
-- orders, order_items — is hidden from them by the owner RLS policies. That is
-- the policies working, not a bug to route around with a broader grant.
--
-- So the whole operation lives here instead: SECURITY DEFINER, scoped to one
-- table at one business, and doing exactly one thing. Two properties fall out
-- of putting it in the database rather than the API:
--
--   * Prices are read from the menu inside the transaction that writes them.
--     The client sends item ids and quantities only; a client that could name
--     its own prices could order a biryani for one rupee.
--   * The advisory lock serialises rounds for one table, so two phones tapping
--     "Place order" simultaneously produce one order with two batches rather
--     than racing the partial unique index and failing.

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
    v_daily := next_daily_number(p_business_id, v_day);
    v_batch := 1;
    INSERT INTO orders (id, business_id, table_id, status, business_day, daily_number, placed_at, updated_at)
    VALUES (gen_random_uuid(), p_business_id, p_table_id, 'placed', v_day, v_daily, now(), now())
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

  RETURN get_table_order(p_table_id);
END;
$$;

GRANT EXECUTE ON FUNCTION place_table_round(uuid, uuid, jsonb) TO menu_app;
