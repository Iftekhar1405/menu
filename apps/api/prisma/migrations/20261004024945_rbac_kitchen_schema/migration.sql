-- RBAC: kitchen staff accounts — schema.
--
-- Part 1 of several in the RBAC kitchen rollout: tables, columns and
-- indexes only. Policies, guards and audit land in their own separate
-- migrations (rbac_kitchen_policies, rbac_kitchen_guards,
-- rbac_kitchen_audit) so each migration file is self-contained and
-- deployable on its own — Prisma checksums a migration on apply and
-- refuses one modified afterward, so later tasks cannot append here.

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('kitchen');

-- CreateEnum
CREATE TYPE "StaffStatus" AS ENUM ('active', 'suspended');

-- AlterEnum
-- Postgres cannot use a new enum value inside the transaction that adds it,
-- so 'kitchen' is only ever referenced by later migrations and by
-- application code — never below, and never via a column DEFAULT.
ALTER TYPE "UserRole" ADD VALUE 'kitchen';

-- AlterTable
ALTER TABLE "order_events" ADD COLUMN     "actor_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "must_change_pin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "business_staff" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "StaffRole" NOT NULL DEFAULT 'kitchen',
    "status" "StaffStatus" NOT NULL DEFAULT 'active',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "business_staff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "business_staff_business_id_user_id_key" ON "business_staff"("business_id", "user_id");

-- CreateIndex
CREATE INDEX "order_events_actor_id_id_idx" ON "order_events"("actor_id", "id" DESC);

-- AddForeignKey
ALTER TABLE "business_staff" ADD CONSTRAINT "business_staff_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_staff" ADD CONSTRAINT "business_staff_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Load-bearing. These columns are the predicate of every kitchen RLS policy,
-- evaluated against ten tables on every request a kitchen user makes. INCLUDE
-- puts business_id in the index leaf so the lookup never touches the heap.
CREATE INDEX "business_staff_lookup"
  ON "business_staff" ("user_id", "status") INCLUDE ("business_id");
