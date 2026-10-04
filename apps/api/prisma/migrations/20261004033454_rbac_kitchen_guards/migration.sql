-- Part 3: column guards.
--
-- RLS grants a *row*: a kitchen UPDATE on orders or menu_items is otherwise
-- free to rewrite any column on a row it may touch. A policy cannot compare
-- OLD with NEW — USING sees old, WITH CHECK sees new — so the restriction
-- has to be a trigger.
--
-- Columns are compared one by one rather than through to_jsonb or hstore.
-- It is longer, and it fails loudly the day someone adds a column — which is
-- the behaviour worth having, since the silent version would let the new
-- column through.

CREATE OR REPLACE FUNCTION orders_kitchen_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM business_staff
     WHERE user_id = app_current_user_id()
       AND business_id = NEW.business_id
       AND status = 'active'
  ) THEN
    RETURN NEW;  -- not staff: the owner path is unchanged
  END IF;

  IF NEW.status NOT IN ('accepted', 'preparing', 'ready') THEN
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

CREATE TRIGGER orders_kitchen_guard
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_kitchen_guard();

-- menu_items has 17 columns. The guard below pins every one of them except
-- is_available (the permitted column) and updated_at (Prisma writes this on
-- every update, including legitimate kitchen ones, so it cannot be pinned).
-- created_at is explicitly included — easy to miss since it sits next to
-- updated_at, but nothing exempts it from the same rule as the rest.
CREATE OR REPLACE FUNCTION menu_items_kitchen_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM business_staff
     WHERE user_id = app_current_user_id()
       AND business_id = NEW.business_id
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

CREATE TRIGGER menu_items_kitchen_guard
  BEFORE UPDATE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION menu_items_kitchen_guard();
