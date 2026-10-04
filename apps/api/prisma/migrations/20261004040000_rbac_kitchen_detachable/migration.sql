-- Part 5: whether a departing staff member's account can be deleted along
-- with their business_staff row, without exposing that answer as a general
-- account-status oracle.
--
-- staff.service.ts's `remove` used to answer this by temporarily borrowing
-- the departing user's own identity (set_config) so RLS would show their
-- businesses and business_staff rows under their own policies, then
-- restoring the caller's identity. That borrow is wrong outside a request:
-- prisma.db falls back to the base client there, where set_config(..., true)
-- is scoped to a single implicit transaction and is gone before the next
-- statement runs — so the counts would read 0 under no identity, RLS would
-- hide everything, and the guard would invert into deleting unconditionally,
-- which is exactly the unsafe outcome it exists to prevent.
--
-- SECURITY DEFINER so it can read businesses and business_staff while their
-- own policies would hide another owner's rows from the caller; search_path
-- is pinned for the same reason the other functions pin it. The caller's own
-- identity never leaves app_current_user_id() — it is read, not replaced —
-- and the first clause ties the answer to a business the caller actually
-- owns, so this cannot be asked about an arbitrary account.
CREATE OR REPLACE FUNCTION app_user_is_detachable(p_user_id uuid, p_business_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    -- Only answerable about someone staffing a venue the caller owns, so this
    -- cannot be used as a general "tell me about any account" oracle.
    EXISTS (SELECT 1 FROM businesses
             WHERE id = p_business_id AND owner_id = app_current_user_id())
    AND NOT EXISTS (SELECT 1 FROM businesses WHERE owner_id = p_user_id)
    AND NOT EXISTS (SELECT 1 FROM business_staff
                     WHERE user_id = p_user_id AND business_id <> p_business_id)
$$;

REVOKE EXECUTE ON FUNCTION app_user_is_detachable(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app_user_is_detachable(uuid, uuid) TO menu_app;
