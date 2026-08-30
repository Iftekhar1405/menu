-- What the platform admin may read in order to fulfil a merchandise order.
--
-- Reading merch_orders is not enough on its own: to post a box of PVC cards we
-- need the business's name and address, and to print the cards we need those
-- tables' labels and tokens. Without this the admin's own order list fails,
-- because the joined rows come back null under the owner policies.
--
-- Deliberately narrow in two ways. It is SELECT only — an admin can read a
-- business but never edit one. And it covers exactly two tables: businesses
-- and tables. Menus, orders, bills, ratings and everything else stay invisible
-- to us, which is the property the rest of the system depends on.

CREATE POLICY businesses_platform_admin_read ON businesses FOR SELECT
  USING (app_is_platform_admin());

CREATE POLICY tables_platform_admin_read ON tables FOR SELECT
  USING (app_is_platform_admin());
