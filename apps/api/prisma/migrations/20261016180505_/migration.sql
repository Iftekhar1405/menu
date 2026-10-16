-- DropForeignKey
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_business_id_fkey";

-- DropForeignKey
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_order_id_fkey";

-- DropForeignKey
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_table_id_fkey";

-- DropForeignKey
ALTER TABLE "order_events" DROP CONSTRAINT "order_events_business_id_fkey";

-- DropForeignKey
ALTER TABLE "order_events" DROP CONSTRAINT "order_events_order_id_fkey";

-- DropForeignKey
ALTER TABLE "push_subscriptions" DROP CONSTRAINT "push_subscriptions_user_id_fkey";

-- DropIndex
DROP INDEX "business_staff_lookup";

-- AlterTable
ALTER TABLE "businesses" ALTER COLUMN "running_order_enabled" DROP NOT NULL;

-- AlterTable
ALTER TABLE "push_subscriptions" ALTER COLUMN "id" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
