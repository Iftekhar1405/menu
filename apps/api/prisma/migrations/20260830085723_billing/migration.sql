-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "default_tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 5.00,
ADD COLUMN     "gstin" TEXT,
ADD COLUMN     "prices_include_tax" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "receipt_footer" TEXT,
ADD COLUMN     "service_charge_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "service_charge_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "tax_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tax_label" TEXT NOT NULL DEFAULT 'GST';

-- AlterTable
ALTER TABLE "menu_items" ADD COLUMN     "tax_rate" DECIMAL(5,2);

-- CreateTable
CREATE TABLE "bills" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "bill_number" INTEGER NOT NULL,
    "table_label" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "prices_include_tax" BOOLEAN NOT NULL,
    "tax_label" TEXT NOT NULL,
    "service_charge_rate" DECIMAL(5,2) NOT NULL,
    "business_snapshot" JSONB NOT NULL,
    "receipt_footer" TEXT,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "tax_total" DECIMAL(10,2) NOT NULL,
    "service_charge" DECIMAL(10,2) NOT NULL,
    "round_off" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_lines" (
    "id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "variant" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "line_total" DECIMAL(10,2) NOT NULL,
    "line_net" DECIMAL(10,2) NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    "tax_amount" DECIMAL(10,2) NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "bill_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_prompts" (
    "id" UUID NOT NULL,
    "business_id" UUID,
    "business_type" TEXT,
    "rating_band" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "review_prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_ratings" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "stars" INTEGER NOT NULL,
    "prompt_id" UUID,
    "private_feedback" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bills_order_id_key" ON "bills"("order_id");

-- CreateIndex
CREATE INDEX "bills_business_id_issued_at_idx" ON "bills"("business_id", "issued_at");

-- CreateIndex
CREATE UNIQUE INDEX "bills_business_id_bill_number_key" ON "bills"("business_id", "bill_number");

-- CreateIndex
CREATE INDEX "bill_lines_bill_id_position_idx" ON "bill_lines"("bill_id", "position");

-- CreateIndex
CREATE INDEX "bill_lines_business_id_idx" ON "bill_lines"("business_id");

-- CreateIndex
CREATE INDEX "review_prompts_business_id_rating_band_idx" ON "review_prompts"("business_id", "rating_band");

-- CreateIndex
CREATE UNIQUE INDEX "order_ratings_order_id_key" ON "order_ratings"("order_id");

-- CreateIndex
CREATE INDEX "order_ratings_business_id_created_at_idx" ON "order_ratings"("business_id", "created_at");

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_prompts" ADD CONSTRAINT "review_prompts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_ratings" ADD CONSTRAINT "order_ratings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_ratings" ADD CONSTRAINT "order_ratings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- Phase 3: bill generation, time-boxed diner access, ratings.
-- ============================================================================

ALTER TABLE bills          ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills          FORCE  ROW LEVEL SECURITY;
ALTER TABLE bill_lines     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_lines     FORCE  ROW LEVEL SECURITY;
ALTER TABLE order_ratings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_ratings  FORCE  ROW LEVEL SECURITY;
ALTER TABLE review_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_prompts FORCE  ROW LEVEL SECURITY;

CREATE POLICY bills_owner ON bills
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

CREATE POLICY bill_lines_owner ON bill_lines
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

CREATE POLICY order_ratings_owner ON order_ratings
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

-- Platform defaults (business_id IS NULL) are readable by everyone; a
-- business's own prompts are readable only by its owner.
CREATE POLICY review_prompts_read ON review_prompts FOR SELECT
  USING (
    business_id IS NULL
    OR business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id())
  );

CREATE POLICY review_prompts_write ON review_prompts FOR ALL
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));


-- ─── Bill generation ────────────────────────────────────────────────────────
--
-- One statement, because a bill is a set of numbers that must agree with each
-- other. Computing lines in the API and totalling them in a second round trip
-- invites a bill whose lines do not add up to its total.
--
-- Idempotent by design: calling it twice returns the first bill rather than
-- recomputing. Snapshotting is pointless if a reprint can produce different
-- numbers from the original.

CREATE OR REPLACE FUNCTION generate_bill(p_order_id uuid, p_business_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_bill_id      uuid;
  v_biz          record;
  v_order        record;
  v_number       int;
  v_subtotal     numeric(12,4) := 0;
  v_tax_total    numeric(12,4) := 0;
  v_service      numeric(12,4) := 0;
  v_service_tax  numeric(12,4) := 0;
  v_gross        numeric(12,4);
  v_total        numeric(10,2);
  v_line         record;
  v_rate         numeric(5,2);
  v_line_total   numeric(12,4);
  v_line_net     numeric(12,4);
  v_line_tax     numeric(12,4);
  v_pos          int := 0;
BEGIN
  SELECT * INTO v_biz FROM businesses WHERE id = p_business_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Business not found' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT o.id, o.business_id, t.label AS table_label INTO v_order
  FROM orders o JOIN tables t ON t.id = o.table_id
  WHERE o.id = p_order_id AND o.business_id = p_business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- Already billed: hand back the same bill, unchanged.
  SELECT id INTO v_bill_id FROM bills WHERE order_id = p_order_id;
  IF FOUND THEN
    RETURN v_bill_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('bill:' || p_business_id::text));
  SELECT COALESCE(MAX(bill_number), 0) + 1 INTO v_number
  FROM bills WHERE business_id = p_business_id;

  INSERT INTO bills (
    id, business_id, order_id, bill_number, table_label, issued_at, currency,
    prices_include_tax, tax_label, service_charge_rate, business_snapshot,
    receipt_footer, subtotal, tax_total, service_charge, round_off, total
  ) VALUES (
    gen_random_uuid(), p_business_id, p_order_id, v_number, v_order.table_label,
    now(), v_biz.currency, v_biz.prices_include_tax, v_biz.tax_label,
    CASE WHEN v_biz.service_charge_enabled THEN v_biz.service_charge_rate ELSE 0 END,
    jsonb_build_object(
      'name', v_biz.name, 'gstin', v_biz.gstin, 'logoPath', v_biz.logo_path,
      'addressLine1', v_biz.address_line1, 'addressLine2', v_biz.address_line2,
      'city', v_biz.city, 'state', v_biz.state, 'postalCode', v_biz.postal_code
    ),
    v_biz.receipt_footer, 0, 0, 0, 0, 0
  ) RETURNING id INTO v_bill_id;

  FOR v_line IN
    SELECT oi.name_snapshot, oi.variant_snapshot, oi.unit_price, oi.quantity,
           oi.batch, oi.created_at, mi.tax_rate AS item_rate
    FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE oi.order_id = p_order_id
    ORDER BY oi.batch, oi.created_at
  LOOP
    -- A deleted dish falls back to the business rate rather than failing: the
    -- diner still has to be given a bill.
    v_rate := CASE
                WHEN NOT v_biz.tax_enabled THEN 0
                ELSE COALESCE(v_line.item_rate, v_biz.default_tax_rate)
              END;

    v_line_total := v_line.unit_price * v_line.quantity;

    IF v_biz.prices_include_tax AND v_rate > 0 THEN
      -- The menu price already contains the tax; work backwards out of it.
      v_line_net := round(v_line_total / (1 + v_rate / 100), 2);
      v_line_tax := v_line_total - v_line_net;
    ELSE
      v_line_net := v_line_total;
      v_line_tax := round(v_line_total * v_rate / 100, 2);
    END IF;

    INSERT INTO bill_lines (
      id, bill_id, business_id, name, variant, quantity, unit_price,
      line_total, line_net, tax_rate, tax_amount, position
    ) VALUES (
      gen_random_uuid(), v_bill_id, p_business_id, v_line.name_snapshot,
      v_line.variant_snapshot, v_line.quantity, v_line.unit_price,
      v_line_total, v_line_net, v_rate, v_line_tax, v_pos
    );

    v_subtotal  := v_subtotal + v_line_net;
    v_tax_total := v_tax_total + v_line_tax;
    v_pos := v_pos + 1;
  END LOOP;

  IF v_biz.service_charge_enabled AND v_biz.service_charge_rate > 0 THEN
    v_service := round(v_subtotal * v_biz.service_charge_rate / 100, 2);
    IF v_biz.tax_enabled THEN
      v_service_tax := round(v_service * v_biz.default_tax_rate / 100, 2);
      v_tax_total := v_tax_total + v_service_tax;
    END IF;
  END IF;

  v_gross := v_subtotal + v_tax_total + v_service;
  v_total := round(v_gross);

  UPDATE bills SET
    subtotal       = round(v_subtotal, 2),
    tax_total      = round(v_tax_total, 2),
    service_charge = v_service,
    -- Shown as its own line so the arithmetic on the receipt always reconciles.
    round_off      = v_total - round(v_gross, 2),
    total          = v_total
  WHERE id = v_bill_id;

  RETURN v_bill_id;
END;
$fn$;


-- ─── The diner's bill ───────────────────────────────────────────────────────
--
-- The 30-minute window is enforced here, in SQL, rather than in the API. A
-- window checked in application code is a window somebody eventually forgets
-- to check; expressed as a predicate, it cannot be skipped.
--
-- Note there is no bill id parameter. A session can reach exactly one bill —
-- the most recent one for its own table — so there is nothing to enumerate.

CREATE OR REPLACE FUNCTION get_table_bill(p_table_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'id',             b.id,
    'billNumber',     b.bill_number,
    'tableLabel',     b.table_label,
    'issuedAt',       to_char(b.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'currency',       b.currency,
    'taxLabel',       b.tax_label,
    'pricesIncludeTax', b.prices_include_tax,
    'business',       b.business_snapshot,
    'receiptFooter',  b.receipt_footer,
    'subtotal',       b.subtotal::text,
    'taxTotal',       b.tax_total::text,
    'serviceCharge',  b.service_charge::text,
    'serviceChargeRate', b.service_charge_rate::text,
    'roundOff',       b.round_off::text,
    'total',          b.total::text,
    'lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', l.id, 'name', l.name, 'variant', l.variant,
               'quantity', l.quantity, 'unitPrice', l.unit_price::text,
               'lineTotal', l.line_total::text, 'taxRate', l.tax_rate::text,
               'taxAmount', l.tax_amount::text
             ) ORDER BY l.position)
      FROM bill_lines l WHERE l.bill_id = b.id
    ), '[]'::jsonb)
  )
  FROM bills b
  JOIN orders o ON o.id = b.order_id
  WHERE o.table_id = p_table_id
    AND b.issued_at > now() - interval '30 minutes'
  ORDER BY b.issued_at DESC
  LIMIT 1;
$fn$;

-- Removing the service charge. Permitted because an automatic one is not, and
-- the diner is entitled to decline it. Recomputes the total in place; the
-- bill's line items and their tax are untouched.
CREATE OR REPLACE FUNCTION remove_service_charge(p_table_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_bill record;
  v_gross numeric(12,4);
  v_total numeric(10,2);
  v_service_tax numeric(12,4);
  v_biz record;
BEGIN
  SELECT b.* INTO v_bill
  FROM bills b JOIN orders o ON o.id = b.order_id
  WHERE o.table_id = p_table_id
    AND b.issued_at > now() - interval '30 minutes'
  ORDER BY b.issued_at DESC LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_bill.service_charge = 0 THEN
    RETURN get_table_bill(p_table_id);
  END IF;

  SELECT tax_enabled, default_tax_rate INTO v_biz
  FROM businesses WHERE id = v_bill.business_id;

  -- Tax charged on the service charge goes with it.
  v_service_tax := 0;
  IF v_biz.tax_enabled THEN
    v_service_tax := round(v_bill.service_charge * v_biz.default_tax_rate / 100, 2);
  END IF;

  v_gross := v_bill.subtotal + (v_bill.tax_total - v_service_tax);
  v_total := round(v_gross);

  UPDATE bills SET
    service_charge = 0,
    service_charge_rate = 0,
    tax_total = round(v_bill.tax_total - v_service_tax, 2),
    round_off = v_total - round(v_gross, 2),
    total = v_total
  WHERE id = v_bill.id;

  RETURN get_table_bill(p_table_id);
END;
$fn$;


-- ─── Ratings ────────────────────────────────────────────────────────────────
--
-- Ten minutes, again enforced as a predicate rather than a check somebody has
-- to remember to write.

CREATE OR REPLACE FUNCTION get_ratable_order(p_table_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'orderId',       o.id,
    'businessId',    o.business_id,
    'googlePlaceId', b.google_place_id,
    'businessName',  b.name,
    'businessType',  b.type
  )
  FROM orders o
  JOIN businesses b ON b.id = o.business_id
  WHERE o.table_id = p_table_id
    AND o.status = 'completed'
    AND o.completed_at > now() - interval '10 minutes'
    AND NOT EXISTS (SELECT 1 FROM order_ratings r WHERE r.order_id = o.id)
  ORDER BY o.completed_at DESC
  LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION submit_order_rating(
  p_table_id  uuid,
  p_stars     int,
  p_prompt_id uuid,
  p_feedback  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_target jsonb;
BEGIN
  IF p_stars < 1 OR p_stars > 5 THEN
    RAISE EXCEPTION 'Choose between 1 and 5 stars' USING ERRCODE = 'check_violation';
  END IF;

  v_target := get_ratable_order(p_table_id);
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'That order can no longer be rated' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO order_ratings (id, business_id, order_id, table_id, stars, prompt_id, private_feedback, created_at)
  VALUES (
    gen_random_uuid(),
    (v_target->>'businessId')::uuid,
    (v_target->>'orderId')::uuid,
    p_table_id, p_stars, p_prompt_id, NULLIF(trim(coalesce(p_feedback, '')), ''), now()
  );

  RETURN jsonb_build_object('ok', true, 'googlePlaceId', v_target->>'googlePlaceId');
END;
$fn$;

-- Suggested texts for a rating band. Readable without a session because they
-- contain nothing private, and a diner needs them before they have rated.
CREATE OR REPLACE FUNCTION get_review_prompts(p_business_id uuid, p_band text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'text', p.text) ORDER BY p.position), '[]'::jsonb)
  FROM review_prompts p
  WHERE p.rating_band = p_band
    AND (p.business_id = p_business_id OR p.business_id IS NULL)
    AND (
      p.business_type IS NULL
      OR p.business_type = (SELECT type::text FROM businesses WHERE id = p_business_id)
    );
$fn$;

GRANT EXECUTE ON FUNCTION generate_bill(uuid, uuid)                  TO menu_app;
GRANT EXECUTE ON FUNCTION get_table_bill(uuid)                       TO menu_app;
GRANT EXECUTE ON FUNCTION remove_service_charge(uuid)                TO menu_app;
GRANT EXECUTE ON FUNCTION get_ratable_order(uuid)                    TO menu_app;
GRANT EXECUTE ON FUNCTION submit_order_rating(uuid, int, uuid, text)  TO menu_app;
GRANT EXECUTE ON FUNCTION get_review_prompts(uuid, text)             TO menu_app;


-- ─── Platform default review prompts ────────────────────────────────────────
--
-- Written honestly at every band. The low-band texts are not softened, because
-- steering unhappy diners away from Google is review gating: it violates
-- Google's policies and has cost businesses their review counts.

INSERT INTO review_prompts (id, business_id, business_type, rating_band, text, position) VALUES
  (gen_random_uuid(), NULL, NULL, 'great', 'Genuinely excellent. Food came out fast and everything was fresh.', 0),
  (gen_random_uuid(), NULL, NULL, 'great', 'One of the better meals I have had around here. Would come back.', 1),
  (gen_random_uuid(), NULL, NULL, 'great', 'Great food, friendly staff, and ordering from the table was easy.', 2),
  (gen_random_uuid(), NULL, NULL, 'good', 'Good food and quick service. Worth a visit.', 0),
  (gen_random_uuid(), NULL, NULL, 'good', 'Enjoyed the meal. A couple of small things could be better.', 1),
  (gen_random_uuid(), NULL, NULL, 'good', 'Solid food, reasonable prices, no complaints.', 2),
  (gen_random_uuid(), NULL, NULL, 'low', 'The food was not what I hoped for this time.', 0),
  (gen_random_uuid(), NULL, NULL, 'low', 'Service was slow and the order took a while to arrive.', 1),
  (gen_random_uuid(), NULL, NULL, 'low', 'Not a great visit. Sharing so it can be looked into.', 2),
  (gen_random_uuid(), NULL, 'cafe', 'great', 'Excellent coffee and a comfortable place to sit.', 3),
  (gen_random_uuid(), NULL, 'theatre', 'great', 'Quick service at the counter and the snacks were fresh.', 3);
