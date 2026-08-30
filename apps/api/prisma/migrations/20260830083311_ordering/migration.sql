-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('placed', 'preparing', 'ready', 'completed', 'cancelled');

-- CreateTable
CREATE TABLE "tables" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'placed',
    "business_day" DATE NOT NULL,
    "daily_number" INTEGER NOT NULL,
    "placed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "note" TEXT,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "menu_item_id" UUID,
    "name_snapshot" TEXT NOT NULL,
    "variant_snapshot" TEXT,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "batch" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tables_token_key" ON "tables"("token");

-- CreateIndex
CREATE INDEX "tables_business_id_position_idx" ON "tables"("business_id", "position");

-- CreateIndex
CREATE INDEX "orders_business_id_status_idx" ON "orders"("business_id", "status");

-- CreateIndex
CREATE INDEX "orders_table_id_status_idx" ON "orders"("table_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_business_id_business_day_daily_number_key" ON "orders"("business_id", "business_day", "daily_number");

-- CreateIndex
CREATE INDEX "order_items_order_id_batch_idx" ON "order_items"("order_id", "batch");

-- CreateIndex
CREATE INDEX "order_items_business_id_idx" ON "order_items"("business_id");

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- Phase 2 hardening: one open order per table, daily numbering, RLS.
-- ============================================================================


-- ─── 1. One open order per table ────────────────────────────────────────────
--
-- Two phones at the same table WILL place a first round within milliseconds of
-- each other. An application-level "is there an open order?" check loses that
-- race and produces two orders for one table, which then produces two bills.
--
-- A partial unique index makes the database refuse the second one. Completed
-- and cancelled orders fall outside it, which is exactly what frees the table
-- for its next diners.

CREATE UNIQUE INDEX orders_one_open_per_table
  ON orders (table_id)
  WHERE status IN ('placed', 'preparing', 'ready');


-- ─── 2. Daily order numbers ─────────────────────────────────────────────────
--
-- Staff call out "order 14", not a uuid. Allocated per business per day.
-- The advisory lock serialises allocation for one business without blocking
-- any other business's orders.

CREATE OR REPLACE FUNCTION next_daily_number(p_business_id uuid, p_day date)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_number int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_business_id::text || p_day::text));

  SELECT COALESCE(MAX(daily_number), 0) + 1 INTO next_number
  FROM orders
  WHERE business_id = p_business_id AND business_day = p_day;

  RETURN next_number;
END;
$$;


-- ─── 3. Row-level security ──────────────────────────────────────────────────
--
-- Same shape as Phase 1: a row is reachable only if its business belongs to
-- the user id set on this connection. Denied by default when none is set.

ALTER TABLE tables      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tables      FORCE ROW LEVEL SECURITY;
ALTER TABLE orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders      FORCE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;

CREATE POLICY tables_owner ON tables
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

CREATE POLICY orders_owner ON orders
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

CREATE POLICY order_items_owner ON order_items
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));


-- ─── 4. The diner's path ────────────────────────────────────────────────────
--
-- A diner is not a user and has no app.current_user_id, so the owner policies
-- above would deny them everything. Their access instead goes through these
-- SECURITY DEFINER functions, which take a table id the caller could only have
-- obtained from a verified session token — and each one is scoped to a single
-- table's single open order.

CREATE OR REPLACE FUNCTION resolve_table_token(p_token text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'tableId',    t.id,
    'tableLabel', t.label,
    'businessId', b.id,
    'businessName', b.name,
    'publicCode', b.public_code
  )
  FROM tables t
  JOIN businesses b ON b.id = t.business_id
  WHERE t.token = p_token AND t.is_active;
$$;

/* The open order for one table, items included. Returns null when the table
   has none — which is how "show only the current order, never previous ones"
   holds: completing an order drops it out of this result entirely. */
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
    'total', COALESCE((
      SELECT SUM(i.unit_price * i.quantity)::text
      FROM order_items i WHERE i.order_id = o.id
    ), '0')
  )
  FROM orders o
  WHERE o.table_id = p_table_id
    AND o.status IN ('placed', 'preparing', 'ready');
$$;

GRANT EXECUTE ON FUNCTION resolve_table_token(text) TO menu_app;
GRANT EXECUTE ON FUNCTION get_table_order(uuid)     TO menu_app;
GRANT EXECUTE ON FUNCTION next_daily_number(uuid, date) TO menu_app;
