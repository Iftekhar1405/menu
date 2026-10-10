-- A round becomes a thing that has a status.
--
-- Until now a round was order_items.batch: an integer with nowhere to hang a
-- status, a KOT number or a timestamp. Status lived on the order, so
-- place_table_round reset the whole order to 'placed' whenever a table added
-- anything, dragging food that was already ready back to the New column.
--
-- This migration only creates and backfills the structure. The trigger that
-- derives orders.status, and the rewrite of place_table_round, follow in
-- their own migrations so each can be reverted on its own.

CREATE TABLE order_rounds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id     uuid NOT NULL REFERENCES orders(id)     ON DELETE CASCADE,

  -- 1-based, per order. Migrated straight across from order_items.batch so
  -- nothing renumbers and "round 2" still means what it meant yesterday.
  seq          int  NOT NULL,

  -- Denormalised from orders so the KOT serial is unique without a join, and
  -- so a round placed either side of midnight keeps the day it was placed on.
  business_day date NOT NULL,
  -- What the pass calls a ticket. Per business, per day, like daily_number.
  kot_number   int  NOT NULL,

  status       "OrderStatus" NOT NULL DEFAULT 'placed',
  placed_at    timestamptz(6) NOT NULL DEFAULT now(),
  accepted_at  timestamptz(6),
  completed_at timestamptz(6),

  CONSTRAINT order_rounds_order_id_seq_key UNIQUE (order_id, seq),
  CONSTRAINT order_rounds_kot_key UNIQUE (business_id, business_day, kot_number)
);

CREATE INDEX order_rounds_business_status_idx ON order_rounds (business_id, status);
CREATE INDEX order_rounds_order_idx           ON order_rounds (order_id, seq);

-- The next KOT serial for a business on a day.
--
-- Shaped exactly like next_daily_number: callers take the table's advisory
-- lock first, so this is a plain MAX rather than a sequence. A sequence would
-- be per-database and could not restart per business per day.
CREATE OR REPLACE FUNCTION next_kot_number(p_business_id uuid, p_day date)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(MAX(kot_number), 0) + 1
  FROM order_rounds
  WHERE business_id = p_business_id AND business_day = p_day;
$$;

ALTER TABLE order_items ADD COLUMN round_id uuid REFERENCES order_rounds(id) ON DELETE CASCADE;

-- Backfill. One round per distinct (order_id, batch), carrying batch across
-- as seq. KOT numbers are allocated per business-day in the order the rounds
-- were actually placed, so historical tickets get stable, sensible numbers
-- rather than nulls.
INSERT INTO order_rounds (id, business_id, order_id, seq, business_day, kot_number, status, placed_at, completed_at)
SELECT
  gen_random_uuid(),
  o.business_id,
  o.id,
  b.batch,
  o.business_day,
  row_number() OVER (
    PARTITION BY o.business_id, o.business_day
    ORDER BY b.first_at, o.id, b.batch
  ),
  o.status,
  b.first_at,
  o.completed_at
FROM orders o
JOIN (
  SELECT order_id, batch, MIN(created_at) AS first_at
  FROM order_items
  GROUP BY order_id, batch
) b ON b.order_id = o.id;

UPDATE order_items i
SET round_id = r.id
FROM order_rounds r
WHERE r.order_id = i.order_id AND r.seq = i.batch;

-- An order with no items at all has no round; it also has no bill and no
-- meaning. Give it one so the derivation trigger is never asked about an
-- empty set in production.
INSERT INTO order_rounds (id, business_id, order_id, seq, business_day, kot_number, status, placed_at, completed_at)
SELECT
  gen_random_uuid(), o.business_id, o.id, 1, o.business_day,
  COALESCE((SELECT MAX(kot_number) FROM order_rounds r2
            WHERE r2.business_id = o.business_id AND r2.business_day = o.business_day), 0)
    + row_number() OVER (PARTITION BY o.business_id, o.business_day ORDER BY o.id),
  o.status, o.placed_at, o.completed_at
FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM order_rounds r WHERE r.order_id = o.id);

ALTER TABLE order_items ALTER COLUMN round_id SET NOT NULL;
ALTER TABLE order_items DROP COLUMN batch;

CREATE INDEX order_items_round_idx ON order_items (round_id, created_at);

-- RLS, in the same shape as order_items: owners reach their own venue's
-- rounds, kitchen staff reach the venues they work at. FORCE as well as
-- ENABLE, because every other tenant-owned table in this schema is forced.
ALTER TABLE order_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_rounds FORCE  ROW LEVEL SECURITY;

CREATE POLICY order_rounds_owner ON order_rounds
  FOR ALL
  USING      (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

CREATE POLICY order_rounds_kitchen_read ON order_rounds FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));

-- Kitchen may update a round at its own venues. Note that this grants the
-- whole row, exactly as orders_kitchen_write does: on `orders` it is the
-- separate orders_kitchen_guard trigger, not the policy, that narrows a
-- kitchen write down to `status`. order_rounds has no such trigger yet, so
-- until one lands a kitchen user can also rewrite seq, kot_number and the
-- timestamps on a round they can already reach.
CREATE POLICY order_rounds_kitchen_update ON order_rounds FOR UPDATE
  USING      (business_id IN (SELECT app_staff_business_ids()))
  WITH CHECK (business_id IN (SELECT app_staff_business_ids()));

GRANT SELECT, INSERT, UPDATE ON order_rounds TO menu_app;
GRANT EXECUTE ON FUNCTION next_kot_number(uuid, date) TO menu_app;
