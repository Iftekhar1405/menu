-- Fix round 1 on rbac_kitchen_guards.
--
-- 1. The staff lookup now keys on OLD.business_id, not NEW.business_id. A
--    kitchen user who rewrites business_id to a venue they are not staff of
--    used to make the NOT EXISTS lookup true against the *new* value, taking
--    the non-staff path and returning NEW unexamined — skipping every column
--    check, including the one that would have caught the business_id
--    rewrite itself. Today that row is still rejected by *_kitchen_write's
--    WITH CHECK, but that is a policy living in a different migration; the
--    guard must not depend on it. OLD.business_id is what decided staff
--    membership of the row as it existed before the write, and
--    business_id stays in the compared-column list so an attempted rewrite
--    is still caught and raises, now from inside the guard itself.
--
-- 2. The status whitelist now only evaluates when status actually changes.
--    Previously it ran unconditionally, so a kitchen write to an order that
--    happened to be sitting in 'placed' or 'completed' (touching only, say,
--    nothing — any UPDATE re-supplies the old value when a column isn't in
--    the SET list) failed with the misleading "may not set order status to
--    placed". The column-equality check below still catches every
--    non-status change regardless.

CREATE OR REPLACE FUNCTION orders_kitchen_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM business_staff
     WHERE user_id = app_current_user_id()
       AND business_id = OLD.business_id
       AND status = 'active'
  ) THEN
    RETURN NEW;  -- not staff: the owner path is unchanged
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status NOT IN ('accepted', 'preparing', 'ready') THEN
    RAISE EXCEPTION 'kitchen staff may not set order status to %', NEW.status
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id            IS DISTINCT FROM OLD.id
  OR NEW.business_id   IS DISTINCT FROM OLD.business_id
  OR NEW.table_id      IS DISTINCT FROM OLD.table_id
  OR NEW.business_day  IS DISTINCT FROM OLD.business_day
  OR NEW.daily_number  IS DISTINCT FROM OLD.daily_number
  OR NEW.placed_at     IS DISTINCT FROM OLD.placed_at
  OR NEW.completed_at  IS DISTINCT FROM OLD.completed_at
  OR NEW.is_running    IS DISTINCT FROM OLD.is_running
  OR NEW.note          IS DISTINCT FROM OLD.note THEN
    RAISE EXCEPTION 'kitchen staff may only change an order''s status'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION menu_items_kitchen_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM business_staff
     WHERE user_id = app_current_user_id()
       AND business_id = OLD.business_id
       AND status = 'active'
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.id             IS DISTINCT FROM OLD.id
  OR NEW.business_id    IS DISTINCT FROM OLD.business_id
  OR NEW.category_id    IS DISTINCT FROM OLD.category_id
  OR NEW.name           IS DISTINCT FROM OLD.name
  OR NEW.price          IS DISTINCT FROM OLD.price
  OR NEW.description    IS DISTINCT FROM OLD.description
  OR NEW.position       IS DISTINCT FROM OLD.position
  OR NEW.diet_tag       IS DISTINCT FROM OLD.diet_tag
  OR NEW.spice_level    IS DISTINCT FROM OLD.spice_level
  OR NEW.prep_time_mins IS DISTINCT FROM OLD.prep_time_mins
  OR NEW.ingredients    IS DISTINCT FROM OLD.ingredients
  OR NEW.allergens      IS DISTINCT FROM OLD.allergens
  OR NEW.nutrition      IS DISTINCT FROM OLD.nutrition
  OR NEW.created_at     IS DISTINCT FROM OLD.created_at
  OR NEW.tax_rate       IS DISTINCT FROM OLD.tax_rate THEN
    RAISE EXCEPTION 'kitchen staff may only change a dish''s availability'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;
