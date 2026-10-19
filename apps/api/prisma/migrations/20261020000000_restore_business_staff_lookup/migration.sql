-- Restore business_staff_lookup, dropped by the drift migration 20261016180505_.
--
-- 20261004024945_rbac_kitchen_schema created it in raw SQL and called it
-- load-bearing: (user_id, status) is the predicate of app_staff_business_ids(),
-- which every kitchen RLS policy calls, on ten tables, on every request a
-- kitchen user makes, and business_id is the column it returns.
--
-- It was dropped because `prisma migrate dev` diffs the database against
-- schema.prisma, and an index that exists only in raw SQL reads as drift to be
-- cleaned up. Restoring it as it was would not hold: Prisma has no syntax for
-- INCLUDE, so it reads the covering index as a plain one and rewrites it on the
-- next diff, quietly dropping the INCLUDE.
--
-- So business_id moves from the leaf payload into the key. A three-column btree
-- answers `user_id = $1 AND status = 'active' -> business_id` with the same
-- index-only scan the INCLUDE bought, and it is a shape Prisma can express
-- exactly — the matching @@index goes into schema.prisma in this commit and the
-- diff comes back empty. The cost is a slightly wider key.
DROP INDEX IF EXISTS "business_staff_lookup";

CREATE INDEX "business_staff_lookup"
  ON "business_staff" ("user_id", "status", "business_id");
