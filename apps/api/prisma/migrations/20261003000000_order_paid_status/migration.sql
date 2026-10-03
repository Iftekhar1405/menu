-- The `paid` status.
--
-- Alone in its own migration for the same reason as `accepted`: Postgres
-- will not let a new enum value be used in the transaction that added it,
-- and the functions that name 'paid' live in the next folder.
--
-- AFTER 'completed': listForBusiness sorts by status, and a paid order
-- belongs after a served one.
ALTER TYPE "OrderStatus" ADD VALUE 'paid' AFTER 'completed';
