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
-- LOCKING: nothing taken beyond the row locks the UPDATE needs, and nothing
-- needed. A round moved concurrently fires the derivation, whose UPDATE of the
-- same orders row blocks on ours and then re-derives from the rounds as they
-- stand at that moment — so the trigger writes last and a mid-flight order
-- cannot be left holding our stale value. The converse, this statement waiting
-- on a request's row lock, is a wait and not a cycle. It is still a full scan of
-- orders inside the migration's transaction, so it belongs in the same quiet
-- window as the rest of this plan's migrations rather than mid-service.
--
-- Runs as the migration role, which writes past the FORCE ROW LEVEL SECURITY on
-- orders. That is the same assumption 20261005090000_order_rounds' backfill
-- already makes on this branch; had it not held, that backfill was a no-op too
-- and nothing here would work.

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
