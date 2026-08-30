-- CreateEnum
CREATE TYPE "MerchStatus" AS ENUM ('requested', 'quoted', 'confirmed', 'in_production', 'shipped', 'delivered', 'cancelled');

-- CreateTable
CREATE TABLE "merch_products" (
    "id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "blurb" TEXT NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "min_quantity" INTEGER NOT NULL DEFAULT 1,
    "lead_time_days" INTEGER NOT NULL DEFAULT 7,
    "per_table" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "merch_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merch_orders" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "order_number" INTEGER NOT NULL,
    "status" "MerchStatus" NOT NULL DEFAULT 'requested',
    "contact_name" TEXT NOT NULL,
    "contact_phone" TEXT NOT NULL,
    "contact_email" TEXT,
    "address_line1" TEXT NOT NULL,
    "address_line2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "postal_code" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "notes" TEXT,
    "admin_notes" TEXT,
    "quoted_total" DECIMAL(10,2),
    "estimated_total" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "merch_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merch_order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "table_ids" UUID[],

    CONSTRAINT "merch_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merch_products_sku_key" ON "merch_products"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "merch_orders_order_number_key" ON "merch_orders"("order_number");

-- CreateIndex
CREATE INDEX "merch_orders_business_id_created_at_idx" ON "merch_orders"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "merch_orders_status_created_at_idx" ON "merch_orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "merch_order_items_order_id_idx" ON "merch_order_items"("order_id");

-- AddForeignKey
ALTER TABLE "merch_orders" ADD CONSTRAINT "merch_orders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merch_order_items" ADD CONSTRAINT "merch_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "merch_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merch_order_items" ADD CONSTRAINT "merch_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "merch_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- Phase 4: the platform admin, and the one boundary they may cross.
-- ============================================================================

-- Every policy up to now has asked a single question: does this row belong to a
-- business owned by the current user. Fulfilling a merchandise order requires
-- reading rows that belong to someone else, so this adds a second clause — and
-- adds it to the merch tables ONLY.
--
-- A platform admin still cannot read another business's menu, orders, bills or
-- ratings. The blast radius of this function is exactly three tables.

CREATE OR REPLACE FUNCTION app_is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM users
    WHERE id = app_current_user_id()
      AND role = 'platform_admin'
  );
$fn$;

GRANT EXECUTE ON FUNCTION app_is_platform_admin() TO menu_app;


ALTER TABLE merch_products     ENABLE ROW LEVEL SECURITY;
ALTER TABLE merch_products     FORCE  ROW LEVEL SECURITY;
ALTER TABLE merch_orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE merch_orders       FORCE  ROW LEVEL SECURITY;
ALTER TABLE merch_order_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE merch_order_items  FORCE  ROW LEVEL SECURITY;

-- The catalogue is public to any signed-in owner; only we can change it.
CREATE POLICY merch_products_read ON merch_products FOR SELECT
  USING (true);

CREATE POLICY merch_products_write ON merch_products FOR ALL
  USING (app_is_platform_admin())
  WITH CHECK (app_is_platform_admin());

-- An owner sees their own requests. We see all of them.
CREATE POLICY merch_orders_access ON merch_orders
  USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id())
    OR app_is_platform_admin()
  )
  WITH CHECK (
    business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id())
    OR app_is_platform_admin()
  );

CREATE POLICY merch_order_items_access ON merch_order_items
  USING (
    order_id IN (
      SELECT o.id FROM merch_orders o
      WHERE o.business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id())
    )
    OR app_is_platform_admin()
  )
  WITH CHECK (
    order_id IN (
      SELECT o.id FROM merch_orders o
      WHERE o.business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id())
    )
    OR app_is_platform_admin()
  );


-- Platform-wide sequential order number. Serialised with an advisory lock so
-- two owners submitting at once cannot take the same number.
CREATE OR REPLACE FUNCTION next_merch_order_number()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_next int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('merch_order_number'));
  SELECT COALESCE(MAX(order_number), 1000) + 1 INTO v_next FROM merch_orders;
  RETURN v_next;
END;
$fn$;

GRANT EXECUTE ON FUNCTION next_merch_order_number() TO menu_app;
