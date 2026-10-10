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
--
-- ─── DO NOT DEPLOY THIS AHEAD OF TASKS 5-8 ──────────────────────────────────
--
-- This migration is one-shot, irreversible and destructive: it drops
-- order_items.batch. Four PL/pgSQL functions still reference i.batch, and
-- because Postgres stores their bodies as text it raises NOTHING when this
-- migration is applied. They break on first call — which is a diner placing
-- an order, a diner opening their table, a diner cancelling, or staff asking
-- for a bill. Each is repaired by its own later task:
--
--   place_table_round   -> Task 5   (also the only writer of order_rounds)
--   get_table_order     -> Task 6
--   cancel_table_order  -> Task 7
--   generate_bill       -> Task 8
--
-- The web board additionally reads item.batch straight off the payload
-- (apps/web/app/(app)/orders/page.tsx, apps/web/components/order/ordering.tsx)
-- and renders its round headers from it; that is repaired by Tasks 6 and 11.
--
-- Deploy this only as part of the whole series, never on its own.

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

-- Kitchen may update a round at its own venues. Like orders_kitchen_write
-- this grants the whole row; order_rounds_kitchen_guard below is what
-- narrows it to status and the two timestamps that record one.
CREATE POLICY order_rounds_kitchen_update ON order_rounds FOR UPDATE
  USING      (business_id IN (SELECT app_staff_business_ids()))
  WITH CHECK (business_id IN (SELECT app_staff_business_ids()));

-- RLS grants a *row*. Without the guard below, a kitchen account that may
-- touch a round is free to rewrite any column on it — including order_id,
-- which would move the round, and every item hanging off it, onto a
-- different order and so onto a different bill. A policy cannot express
-- this: USING sees only OLD and WITH CHECK only NEW, so comparing them has
-- to be a trigger. Same shape as orders_kitchen_guard, which is the
-- precedent for the pattern.
--
-- Both lessons from that guard's own fix round are built in here from the
-- start. The staff lookup keys on OLD.business_id, not NEW: keying on NEW
-- let a business_id rewrite make the lookup miss, take the "not staff"
-- branch and return NEW unexamined, skipping every column check including
-- the one that would have caught the rewrite. And the status whitelist only
-- evaluates when status actually changes, because an UPDATE re-supplies the
-- current value for every column not in its SET list, which would otherwise
-- reject an unrelated write with a misleading message about its status.
CREATE OR REPLACE FUNCTION order_rounds_kitchen_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM business_staff
     WHERE user_id = app_current_user_id()
       AND business_id = OLD.business_id
       AND status = 'active'
  ) THEN
    RETURN NEW;  -- not staff: the owner path is unchanged
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status NOT IN ('accepted', 'preparing', 'ready') THEN
    RAISE EXCEPTION 'kitchen staff may not set round status to %', NEW.status
      USING ERRCODE = '42501';
  END IF;

  -- Every column except the three a kitchen write is for: status and the two
  -- timestamps that record it. Compared one by one rather than through
  -- to_jsonb, so that the day someone adds a column this fails loudly
  -- instead of silently letting the new column through.
  IF NEW.id           IS DISTINCT FROM OLD.id
  OR NEW.business_id  IS DISTINCT FROM OLD.business_id
  OR NEW.order_id     IS DISTINCT FROM OLD.order_id
  OR NEW.seq          IS DISTINCT FROM OLD.seq
  OR NEW.business_day IS DISTINCT FROM OLD.business_day
  OR NEW.kot_number   IS DISTINCT FROM OLD.kot_number
  OR NEW.placed_at    IS DISTINCT FROM OLD.placed_at THEN
    RAISE EXCEPTION 'kitchen staff may only change a round''s status'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER order_rounds_kitchen_guard
  BEFORE UPDATE ON order_rounds
  FOR EACH ROW EXECUTE FUNCTION order_rounds_kitchen_guard();

GRANT SELECT, INSERT, UPDATE ON order_rounds TO menu_app;
GRANT EXECUTE ON FUNCTION next_kot_number(uuid, date) TO menu_app;
