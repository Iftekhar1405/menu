-- Payment on the bill, and every function that treats 'completed' as the
-- finished state taught that 'paid' is finished too.
--
-- WARNING carried forward from transitions.ts: status lists are written out
-- by hand in SQL. OPEN statuses are unchanged here — 'paid' is not open — so
-- orders_one_open_per_table is untouched. Each function below is copied
-- verbatim from its latest definition with only the noted predicate changed.

CREATE TYPE "PaymentMode" AS ENUM ('cash', 'upi', 'card', 'other');

ALTER TABLE "bills"
  ADD COLUMN "payment_mode" "PaymentMode",
  ADD COLUMN "paid_at" TIMESTAMPTZ(6),
  -- Paid means both or neither. A mode with no time, or a time with no mode,
  -- is a half-written payment.
  ADD CONSTRAINT "bills_paid_consistent"
    CHECK (("payment_mode" IS NULL) = ("paid_at" IS NULL));

CREATE INDEX "bills_business_id_payment_mode_issued_at_idx"
  ON "bills" ("business_id", "payment_mode", "issued_at");

-- place_table_round (from 20260928000000_order_round_fixes): a table that was
-- served *and paid* inside the window is still a returning table.
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
         AND status IN ('completed', 'paid')
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


-- get_table_order (from 20260928000000_order_round_fixes): a paid order is
-- recently closed, like a served one.
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
      (o.status IN ('completed', 'paid', 'cancelled')
       AND o.placed_at > now() - interval '2 hours')
    )
  ORDER BY
    -- Open orders first, then most recent. A table may have a completed order
    -- from earlier and a new open one; the open one is always what is wanted.
    CASE WHEN o.status IN ('placed','accepted','preparing','ready') THEN 0 ELSE 1 END,
    o.placed_at DESC
  LIMIT 1;
$$;


-- get_ratable_order (from 20260830085723_billing): paying must not take away
-- the diner's chance to rate.
CREATE OR REPLACE FUNCTION get_ratable_order(p_table_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'orderId',       o.id,
    'businessId',    o.business_id,
    'googlePlaceId', b.google_place_id,
    'businessName',  b.name,
    'businessType',  b.type
  )
  FROM orders o
  JOIN businesses b ON b.id = o.business_id
  WHERE o.table_id = p_table_id
    AND o.status IN ('completed', 'paid')
    AND o.completed_at > now() - interval '10 minutes'
    AND NOT EXISTS (SELECT 1 FROM order_ratings r WHERE r.order_id = o.id)
  ORDER BY o.completed_at DESC
  LIMIT 1;
$fn$;

-- remove_service_charge (from 20260830085723_billing): refused once paid.
CREATE OR REPLACE FUNCTION remove_service_charge(p_table_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_bill record;
  v_gross numeric(12,4);
  v_total numeric(10,2);
  v_service_tax numeric(12,4);
  v_biz record;
BEGIN
  SELECT b.* INTO v_bill
  FROM bills b JOIN orders o ON o.id = b.order_id
  WHERE o.table_id = p_table_id
    AND b.issued_at > now() - interval '30 minutes'
  ORDER BY b.issued_at DESC LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_bill.service_charge = 0 THEN
    RETURN get_table_bill(p_table_id);
  END IF;

  -- Money has already changed hands for this amount. Removing the charge now
  -- would leave a recorded payment that no longer matches its bill.
  IF v_bill.paid_at IS NOT NULL THEN
    RAISE EXCEPTION 'This bill is already paid — ask a member of staff'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT tax_enabled, default_tax_rate INTO v_biz
  FROM businesses WHERE id = v_bill.business_id;

  -- Tax charged on the service charge goes with it.
  v_service_tax := 0;
  IF v_biz.tax_enabled THEN
    v_service_tax := round(v_bill.service_charge * v_biz.default_tax_rate / 100, 2);
  END IF;

  v_gross := v_bill.subtotal + (v_bill.tax_total - v_service_tax);
  v_total := round(v_gross);

  UPDATE bills SET
    service_charge = 0,
    service_charge_rate = 0,
    tax_total = round(v_bill.tax_total - v_service_tax, 2),
    round_off = v_total - round(v_gross, 2),
    total = v_total
  WHERE id = v_bill.id;

  RETURN get_table_bill(p_table_id);
END;
$fn$;

