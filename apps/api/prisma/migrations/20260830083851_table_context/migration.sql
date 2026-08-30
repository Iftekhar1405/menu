-- The diner's view of their own table.
--
-- Table rows are under the owner RLS policy, and a diner has no
-- app.current_user_id — so an ordinary query returns nothing for them, which
-- is the policy behaving correctly. Their access goes through here instead:
-- SECURITY DEFINER, and scoped to exactly one table id that the caller could
-- only have obtained from a verified session token.
--
-- is_active is returned rather than filtered so the API can tell "no such
-- table" from "this table has been taken out of service", which are different
-- messages for the diner holding the card.

CREATE OR REPLACE FUNCTION get_table_context(p_table_id uuid, p_business_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'tableId',      t.id,
    'tableLabel',   t.label,
    'isActive',     t.is_active,
    'businessId',   b.id,
    'businessName', b.name,
    'publicCode',   b.public_code,
    'currency',     b.currency
  )
  FROM tables t
  JOIN businesses b ON b.id = t.business_id
  WHERE t.id = p_table_id AND t.business_id = p_business_id;
$$;

GRANT EXECUTE ON FUNCTION get_table_context(uuid, uuid) TO menu_app;
