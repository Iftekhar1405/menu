-- Part 2: kitchen policies, beside the owner policies rather than replacing
-- them. The cost of that choice is two parallel rules per table; the
-- drift-guard test in kitchen-policies.spec.ts is what stops them separating.

ALTER TABLE "business_staff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business_staff" FORCE  ROW LEVEL SECURITY;

-- SECURITY DEFINER so it can read business_staff while that table's own
-- policies hide it. search_path is pinned for the same reason the other 33
-- functions pin it. The identity check is inside the body, so it cannot be
-- asked about anyone but the caller.
CREATE OR REPLACE FUNCTION app_staff_business_ids() RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT business_id FROM business_staff
   WHERE user_id = app_current_user_id() AND status = 'active'
$$;

REVOKE EXECUTE ON FUNCTION app_staff_business_ids() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app_staff_business_ids() TO menu_app;

-- An owner manages their own venues' staff; a staff member may read only
-- their own row, so the app can tell them which venue they belong to.
CREATE POLICY business_staff_owner ON business_staff
  USING      (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

CREATE POLICY business_staff_self_read ON business_staff FOR SELECT
  USING (user_id = app_current_user_id());

-- `businesses` is the exception: it has no business_id column because it IS
-- the business. Writing it from the template below would fail outright.
CREATE POLICY businesses_kitchen_read ON businesses FOR SELECT
  USING (id IN (SELECT app_staff_business_ids()));

CREATE POLICY tables_kitchen_read ON tables FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
CREATE POLICY orders_kitchen_read ON orders FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
CREATE POLICY order_items_kitchen_read ON order_items FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
CREATE POLICY order_events_kitchen_read ON order_events FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
CREATE POLICY menu_categories_kitchen_read ON menu_categories FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
CREATE POLICY menu_items_kitchen_read ON menu_items FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
CREATE POLICY menu_item_variants_kitchen_read ON menu_item_variants FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
CREATE POLICY menu_item_photos_kitchen_read ON menu_item_photos FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
CREATE POLICY notifications_kitchen_read ON notifications FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));

-- The only two tables a kitchen user may write. No INSERT and no DELETE
-- policy for kitchen exists anywhere; which *columns* may change is part 3.
CREATE POLICY orders_kitchen_write ON orders FOR UPDATE
  USING      (business_id IN (SELECT app_staff_business_ids()))
  WITH CHECK (business_id IN (SELECT app_staff_business_ids()));

CREATE POLICY menu_items_kitchen_write ON menu_items FOR UPDATE
  USING      (business_id IN (SELECT app_staff_business_ids()))
  WITH CHECK (business_id IN (SELECT app_staff_business_ids()));
