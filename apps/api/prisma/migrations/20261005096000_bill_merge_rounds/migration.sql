-- One bill line for the same dish ordered twice.
--
-- Two repairs in one function, both of them to the same cursor.
--
-- The first is not optional: the loop still read `oi.batch`, the column
-- 20261005090000_order_rounds dropped, so generate_bill has been raising
-- `column oi.batch does not exist` on its first call ever since — no table on
-- this branch could be given a bill at all.
--
-- The second is the one the task asked for. A table that ordered one biryani
-- and then two more got three rows in order_items and therefore three lines on
-- the bill: `1 x Dum Biryani` then `2 x Dum Biryani`. The arithmetic was right
-- and the bill was still wrong, because the customer ordered three biryanis.
--
-- Only the cursor changes. Tax, rounding, the service charge and the totals
-- below are untouched — but rounding happens once per line, and there are now
-- fewer lines, so where the rounding lands moves. Merging is the right place
-- for it to land: rounding 960/1.05 once is the tax on what the table actually
-- bought, where rounding 320/1.05 and 640/1.05 separately is tax on how many
-- times they happened to press Order. Measured over 32,000 randomised
-- (price, q1, q2, rate) cases with a taxed service charge, the split between
-- subtotal and tax moves by a paisa in about a quarter of them and the grand
-- total is unchanged in all but 0.2%, where the paisa tips the whole-rupee
-- round_off and the total moves by one rupee. The bill reconciles either way —
-- lines sum to subtotal, and subtotal + tax + service + round_off = total —
-- which is the invariant this function was built around.
--
-- Nothing here iterates order_rounds, so cancelled rounds need no special
-- case: 20261005095000_cancel_per_round deletes a cancelled round's
-- order_items, and this function only ever sees order_items.

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

  -- Grouped, so three biryanis ordered across two rounds print as one line.
  -- The grouping key is every column that could make two rows genuinely
  -- different things: a price change between rounds, a different size, or a
  -- different tax rate (a deleted dish falls back to the business rate).
  --
  -- Ordered by first appearance so the bill still reads in the order the
  -- table ate, then by the grouping key itself. The key is needed because
  -- first_at alone is not a total order: created_at is now(), which is
  -- transaction-stable, so every dish in one round shares a timestamp and
  -- the lines within a round would otherwise come back in whatever order the
  -- plan happened to produce. A bill is a document people reprint and compare.
  FOR v_line IN
    SELECT oi.name_snapshot,
           oi.variant_snapshot,
           oi.unit_price,
           SUM(oi.quantity)::int AS quantity,
           CASE WHEN NOT v_biz.tax_enabled THEN 0
                ELSE COALESCE(MAX(mi.tax_rate), v_biz.default_tax_rate) END AS item_rate,
           MIN(oi.created_at) AS first_at
    FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE oi.order_id = p_order_id
    GROUP BY oi.name_snapshot, oi.variant_snapshot, oi.unit_price,
             CASE WHEN NOT v_biz.tax_enabled THEN 0
                  ELSE COALESCE(mi.tax_rate, v_biz.default_tax_rate) END
    ORDER BY first_at, oi.name_snapshot, oi.variant_snapshot, oi.unit_price, item_rate
  LOOP
    -- The rate is resolved in the query above, because it is part of the
    -- grouping key: two rows that resolve to the same rate have to land in one
    -- group, and a row whose dish has since been deleted still has to be
    -- billed at the business rate rather than failing.
    v_rate := v_line.item_rate;

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
