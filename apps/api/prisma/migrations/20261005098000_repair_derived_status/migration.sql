-- Repairs orders.status rows left disagreeing with the rounds they are derived
-- from.
--
-- WHAT THIS IS NOT: a backfill. order_rounds was backfilled in
-- 20261005090000_order_rounds, and orders.status has been derived by
-- order_rounds_derive_status since 20261005091000. This is a one-shot repair of
-- rows a *defect* produced, and it is correct exactly once. Do not reach for it
-- as a routine resync: if rows are still diverging after this, the derivation
-- itself is broken, and copying this statement forward would hide that instead
-- of fixing it.
--
-- WHAT PRODUCED THEM: until the order-level setStatus stopped writing the
-- column (apps/api/src/orders/orders.service.ts), two things authored
-- orders.status — that hand-write and this trigger — and the hand-write could
-- land last. The reachable sequence: staff open the board and read an order as
-- 'preparing'; a diner's cancel_table_order cancels its last live round and the
-- trigger derives 'cancelled'; the staff transaction then writes 'ready' over
-- it. The row is left with a live status over no live round, which the
-- derivation would never produce.
--
-- WHY IT MATTERS ENOUGH TO SHIP A MIGRATION FOR IT: such an order can never be
-- closed — nothing can move a round it has not got, and the service now refuses
-- the attempt with a 409 rather than a silent 200 — and orders_one_open_per_table,
-- the partial unique index allowing a table exactly one open order, then blocks
-- that table from taking a new one. The table is dead to the venue until this
-- runs.
--
-- THE WHERE CLAUSE IS THE SAFETY PROPERTY, not an optimisation. It matches only
-- rows already wrong by the invariant this plan introduced, so against a correct
-- database the statement updates zero rows and running it twice is the same as
-- running it once. Do not widen it. In particular a row whose status is right is
-- left alone entirely, completed_at included: that would be a different
-- divergence from the one described above, and chasing it here would cost the
-- zero-rows property that makes this safe to run at all.
--
-- completed_at is repaired alongside, with the CASE copied from
-- order_rounds_derive_status_fn, because the trigger owns that column too. A row
-- dragged to 'completed' without it would be a completed order carrying no
-- completion time, which billing reads.
--
-- orders_log_status fires for every row this touches, writing an order_events
-- row with a null actor. That is wanted, not tolerated: the status really did
-- change, the audit trail is the only place a venue could later see that it did,
-- and null is already this schema's word for "nobody we can name" (see
-- 20261004035044_rbac_kitchen_audit). A repair that moved orders silently would
-- be the harder one to explain afterwards.
--
-- LOCKING: the LOCK TABLE below is load-bearing, not belt and braces. Without
-- it this statement is unsound against any concurrent writer it blocks on.
--
-- Under READ COMMITTED, when an UPDATE blocks on a row lock and the blocking
-- transaction commits, Postgres runs EvalPlanQual: it re-reads the TARGET row
-- at its new version, but `d` below is a separate range-table entry and is NOT
-- re-scanned — the saved pre-snapshot tuple is reused. The recheck therefore
-- compares a freshly-correct o.status against a STALE d.status, finds them
-- distinct, and writes the stale value. This is the documented
-- inconsistent-snapshot behaviour of an updating command joined to other rows,
-- and no ordering argument rescues it.
--
-- It is not theoretical here, because a stuck order is both the row class this
-- repairs and a row a diner can still place a round into. place_table_round
-- appends a round, the derivation writes 'placed', this statement unblocks and
-- overwrites it with 'cancelled' plus a completed_at — a live round orphaned
-- under a terminal order, which is worse than what it was sent to fix. The
-- trigger does not undo it either: order_rounds_derive_status_fn computes
-- v_status once, before its own UPDATE, so it does not re-derive on unblocking
-- any more than this does. The window is this statement's whole runtime, which
-- is a full scan calling derive_order_status per row.
--
-- SHARE ROW EXCLUSIVE conflicts with the ROW EXCLUSIVE that every INSERT and
-- UPDATE takes. Writers therefore queue behind this migration and this
-- migration never blocks on a writer it has already excluded, so the
-- blocked-then-unblocked recheck above cannot arise — and the waiting is
-- one-directional, so there is still no cycle. The price is that writes to
-- orders stop for the statement's duration, which is the other reason this
-- belongs in the same quiet window as the rest of this plan's migrations
-- rather than mid-service.
--
-- Runs as the migration role, which writes past the FORCE ROW LEVEL SECURITY on
-- orders. That is the same assumption 20261005090000_order_rounds' backfill
-- already makes on this branch; had it not held, that backfill was a no-op too
-- and nothing here would work.

LOCK TABLE orders IN SHARE ROW EXCLUSIVE MODE;

UPDATE orders o
SET status = d.status,
    completed_at = CASE
                     WHEN d.status IN ('completed','cancelled')
                       THEN COALESCE(o.completed_at, now())
                     ELSE NULL
                   END,
    updated_at = now()
FROM (SELECT id, derive_order_status(id) AS status FROM orders) d
WHERE o.id = d.id
  AND o.status IS DISTINCT FROM d.status;
