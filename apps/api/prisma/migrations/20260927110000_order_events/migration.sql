-- The order timeline.
--
-- Everything here names 'accepted' as a literal, which is why it cannot share
-- a transaction with the ALTER TYPE that added it — see the previous folder.

-- ── The log ──────────────────────────────────────────────────────────────

CREATE TABLE order_events (
  -- bigserial, and reads order by it rather than by `at`. Accepting an order
  -- and starting it 200ms apart must render in the order they happened, which
  -- a timestamp comparison does not guarantee and insertion order does.
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id)     ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- text, not OrderStatus. Half the kinds are not statuses — 'round_added'
  -- today, a bill or a rating next — and an enum would mean a migration per
  -- new kind for a column nothing joins on.
  kind        text NOT NULL,
  -- { batch, items: [{ name, quantity }] } for the kinds that carry a round.
  -- Empty for status changes, which say everything in `kind` and `at`.
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz(6) NOT NULL DEFAULT now()
);

-- The only read either screen does: one order, oldest first.
CREATE INDEX order_events_order_id_id_idx ON order_events (order_id, id);

ALTER TABLE order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_events FORCE  ROW LEVEL SECURITY;

-- Owners only. Diners reach their own events through get_table_order, which
-- is SECURITY DEFINER, so there is no diner-facing policy here to get wrong.
CREATE POLICY order_events_owner ON order_events
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

GRANT SELECT, INSERT ON order_events TO menu_app;
GRANT USAGE, SELECT ON SEQUENCE order_events_id_seq TO menu_app;

-- ── Status changes are logged by the database itself ─────────────────────

-- A trigger rather than an insert next to every UPDATE.
--
-- Order *creation* has exactly one writer, so place_table_round logs that
-- itself — it is also the only thing that knows the round's contents. Order
-- *status* is written by OrdersService.setStatus today and by whatever
-- admin tooling or bulk close-out exists later. A caller that forgets to log
-- produces a timeline that is wrong rather than absent, and nothing fails.
CREATE OR REPLACE FUNCTION log_order_status_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO order_events (order_id, business_id, kind)
  VALUES (NEW.id, NEW.business_id, NEW.status::text);
  RETURN NULL;
END;
$$;

CREATE TRIGGER orders_log_status
  AFTER UPDATE OF status ON orders
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION log_order_status_event();

-- ── The open-order invariant has to learn about 'accepted' ───────────────

-- Without this the index stops constraining an order the moment staff accept
-- it: 'accepted' falls outside the WHERE clause, the partial index no longer
-- covers the row, and a diner placing a second round gets a brand-new order
-- that nothing refuses. The table then has two open orders and two bills —
-- the exact state this index exists to prevent.
DROP INDEX orders_one_open_per_table;

CREATE UNIQUE INDEX orders_one_open_per_table
  ON orders (table_id)
  WHERE status IN ('placed', 'accepted', 'preparing', 'ready');

-- ── place_table_round: find accepted orders, and log the round ───────────

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

  -- 'accepted' belongs here for the same reason it belongs in the index
  -- above: without it, a second round at an accepted table starts a second
  -- order instead of appending to the one the kitchen is already working on.
  SELECT id INTO v_order_id
  FROM orders
  WHERE table_id = p_table_id
    AND status IN ('placed','accepted','preparing','ready');

  IF FOUND THEN
    SELECT COALESCE(MAX(batch), 0) + 1 INTO v_batch
    FROM order_items WHERE order_id = v_order_id;
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

    -- name, variant and price are copied in as they are right now. A price
    -- change later must not alter what this table is charged.
    INSERT INTO order_items
      (id, order_id, business_id, menu_item_id, name_snapshot, variant_snapshot,
       unit_price, quantity, batch, created_at)
    VALUES
      (gen_random_uuid(), v_order_id, p_business_id, v_item.id, v_item.name,
       v_variant_name, v_price, v_quantity, v_batch, now());
  END LOOP;

  -- Logged here rather than by a trigger because this is the only thing that
  -- knows what was in the round, and the timeline's whole job on a second
  -- round is to explain a total that grew.
  INSERT INTO order_events (order_id, business_id, kind, data)
  SELECT
    v_order_id,
    p_business_id,
    CASE WHEN v_batch = 1 THEN 'placed' ELSE 'round_added' END,
    jsonb_build_object(
      'batch', v_batch,
      'items', COALESCE(jsonb_agg(jsonb_build_object(
        -- The variant is what was actually ordered: a large dosa and a small
        -- one are different lines on a bill.
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

-- ── get_table_order: accepted orders are still the table's order ─────────

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
    -- Embedded rather than fetched separately. The diner's screen shows this
    -- timeline the whole time they are waiting, the database is ~400ms away,
    -- and their existing 5s poll and the Realtime ping already refetch this
    -- exact endpoint — so the timeline becomes live with no new plumbing.
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
    AND o.status IN ('placed', 'accepted', 'preparing', 'ready');
$$;

-- ── Backfill ─────────────────────────────────────────────────────────────

-- Synthesised from the columns that already hold the truth. An order that was
-- mid-service when this deployed gets a two-entry timeline, which is honest:
-- those intermediate timestamps were never recorded. It beats an empty panel.
--
-- Inserted in `at` order so the bigserial ids ascend with time rather than
-- with table scan order — reads sort by id.
INSERT INTO order_events (order_id, business_id, kind, at)
SELECT order_id, business_id, kind, at FROM (
  SELECT id AS order_id, business_id, 'placed' AS kind, placed_at AS at
  FROM orders
  UNION ALL
  SELECT id, business_id, status::text, completed_at
  FROM orders
  WHERE completed_at IS NOT NULL
    AND status IN ('completed', 'cancelled')
) seed
ORDER BY at, order_id;
