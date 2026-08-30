-- ============================================================================
-- Hardening: application role, price guard, row-level security, public menu.
--
-- Read this file before changing anything under it. Three things live here
-- that the application layer cannot be trusted to get right on its own.
-- ============================================================================


-- ─── 1. A non-superuser role for the API ────────────────────────────────────
--
-- Migrations run as the owner. The running API must NOT, because superusers
-- and table owners bypass row-level security entirely — policies written
-- below would silently never apply, and the isolation tests would pass while
-- protecting nothing.
--
-- Production note: on Supabase, run migrations as `postgres` and point
-- APP_DATABASE_URL at a role created the same way as `menu_app` here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'menu_app') THEN
    CREATE ROLE menu_app LOGIN PASSWORD 'menu_app';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO menu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO menu_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO menu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO menu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO menu_app;


-- ─── 2. Price guard ─────────────────────────────────────────────────────────
--
-- The rule: an item carries a price, or it carries variants that do — never
-- neither, never both. A plain CHECK cannot express this because it spans two
-- tables, so it is a DEFERRED constraint trigger: the check runs at COMMIT,
-- by which time an item inserted with its variants in the same transaction
-- looks complete.

CREATE OR REPLACE FUNCTION menu_item_price_guard() RETURNS trigger AS $$
DECLARE
  target_item   uuid;
  item_price    numeric;
  variant_count int;
BEGIN
  IF TG_TABLE_NAME = 'menu_items' THEN
    target_item := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target_item := OLD.item_id;
  ELSE
    target_item := NEW.item_id;
  END IF;

  SELECT price INTO item_price FROM menu_items WHERE id = target_item;
  -- The item itself was removed in this transaction; nothing left to check.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO variant_count
  FROM menu_item_variants WHERE item_id = target_item;

  IF item_price IS NULL AND variant_count = 0 THEN
    RAISE EXCEPTION
      'Item % must have either a price or at least one variant with a price', target_item
      USING ERRCODE = 'check_violation';
  END IF;

  IF item_price IS NOT NULL AND variant_count > 0 THEN
    RAISE EXCEPTION
      'Item % cannot have both a single price and variant prices', target_item
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER menu_items_price_guard
  AFTER INSERT OR UPDATE OF price ON menu_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION menu_item_price_guard();

CREATE CONSTRAINT TRIGGER menu_item_variants_price_guard
  AFTER INSERT OR UPDATE OR DELETE ON menu_item_variants
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION menu_item_price_guard();


-- ─── 3. Row-level security ──────────────────────────────────────────────────
--
-- The second isolation layer. The first is the scoped repository in the API,
-- where businessId can only come from an ownership check. This layer exists
-- for the day someone forgets that check: the query returns nothing instead
-- of another restaurant's menu.
--
-- Every policy resolves to the same question — does this row belong to a
-- business owned by the user id set on this connection? When no user id is
-- set, current_setting returns NULL, every comparison is NULL, and nothing is
-- visible. Denied by default.
--
-- Auth tables (users, otp_challenges, refresh_tokens) are deliberately NOT
-- under RLS: login must find an account before anyone is authenticated, so
-- there is no user id to key a policy on. They are guarded in the auth
-- service instead, and hold no tenant data.

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- FORCE is what makes this real: without it the table owner ignores policies.
ALTER TABLE businesses          ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses          FORCE ROW LEVEL SECURITY;
ALTER TABLE menu_categories     ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_categories     FORCE ROW LEVEL SECURITY;
ALTER TABLE menu_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items          FORCE ROW LEVEL SECURITY;
ALTER TABLE menu_item_variants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_variants  FORCE ROW LEVEL SECURITY;
ALTER TABLE menu_item_photos    ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_photos    FORCE ROW LEVEL SECURITY;
ALTER TABLE menu_views          ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_views          FORCE ROW LEVEL SECURITY;

CREATE POLICY businesses_owner ON businesses
  USING (owner_id = app_current_user_id())
  WITH CHECK (owner_id = app_current_user_id());

-- The child tables all carry business_id directly, so each policy stays a
-- single indexed predicate against the owned-business set.
CREATE POLICY menu_categories_owner ON menu_categories
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

CREATE POLICY menu_items_owner ON menu_items
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

CREATE POLICY menu_item_variants_owner ON menu_item_variants
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

CREATE POLICY menu_item_photos_owner ON menu_item_photos
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

CREATE POLICY menu_views_owner ON menu_views
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));


-- ─── 4. The public menu ─────────────────────────────────────────────────────
--
-- One function, one code, one menu. The diner-facing page makes exactly this
-- call and nothing else, which is what keeps a scan to a single query — and
-- means no anonymous path can enumerate businesses or read a hidden category.
--
-- SECURITY DEFINER so it runs as the owner and is not blocked by the policies
-- above. It is safe to run privileged because it takes only a public code and
-- returns only rows already marked visible and available.

CREATE OR REPLACE FUNCTION get_public_menu(p_code text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'business', jsonb_build_object(
      'id',         b.id,
      'name',       b.name,
      'type',       b.type,
      'logoPath',   b.logo_path,
      'currency',   b.currency,
      'publicCode', b.public_code,
      'address', CASE
        WHEN b.address_line1 IS NULL AND b.city IS NULL THEN NULL
        ELSE jsonb_build_object(
          'line1',      b.address_line1,
          'line2',      b.address_line2,
          'city',       b.city,
          'state',      b.state,
          'postalCode', b.postal_code,
          'country',    b.country
        )
      END
    ),
    'theme', jsonb_build_object(
      'layout',      b.theme_layout,
      'accent',      b.theme_accent,
      'fontPairing', b.theme_font
    ),
    'updatedAt', to_char(b.menu_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'categories', COALESCE((
      SELECT jsonb_agg(cat ORDER BY cat_position)
      FROM (
        SELECT
          c.position AS cat_position,
          jsonb_build_object(
            'id',   c.id,
            'name', c.name,
            'items', COALESCE((
              SELECT jsonb_agg(item ORDER BY item_position)
              FROM (
                SELECT
                  i.position AS item_position,
                  jsonb_build_object(
                    'id',           i.id,
                    'name',         i.name,
                    'price',        CASE WHEN i.price IS NULL THEN NULL ELSE i.price::text END,
                    'description',  i.description,
                    'dietTag',      i.diet_tag,
                    'spiceLevel',   i.spice_level,
                    'prepTimeMins', i.prep_time_mins,
                    'ingredients',  i.ingredients,
                    'allergens',    COALESCE(to_jsonb(i.allergens), '[]'::jsonb),
                    'nutrition',    i.nutrition,
                    'variants', COALESCE((
                      SELECT jsonb_agg(jsonb_build_object(
                               'id', v.id, 'name', v.name, 'price', v.price::text
                             ) ORDER BY v.position)
                      FROM menu_item_variants v WHERE v.item_id = i.id
                    ), '[]'::jsonb),
                    'photos', COALESCE((
                      SELECT jsonb_agg(jsonb_build_object(
                               'id', p.id, 'path', p.storage_path, 'alt', p.alt
                             ) ORDER BY p.position)
                      FROM menu_item_photos p WHERE p.item_id = i.id
                    ), '[]'::jsonb)
                  ) AS item
                FROM menu_items i
                WHERE i.category_id = c.id
                  AND i.is_available
              ) items_ordered
            ), '[]'::jsonb)
          ) AS cat
        FROM menu_categories c
        WHERE c.business_id = b.id
          AND c.is_visible
      ) cats_ordered
    ), '[]'::jsonb)
  )
  FROM businesses b
  WHERE b.public_code = p_code;
$$;

GRANT EXECUTE ON FUNCTION get_public_menu(text) TO menu_app;
GRANT EXECUTE ON FUNCTION app_current_user_id() TO menu_app;


-- ─── 5. View counter ────────────────────────────────────────────────────────
--
-- SECURITY DEFINER for the same reason: the diner incrementing it is not the
-- owner, so no policy would let them write the row.

CREATE OR REPLACE FUNCTION record_menu_view(p_code text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_business uuid;
BEGIN
  SELECT id INTO target_business FROM businesses WHERE public_code = p_code;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO menu_views (id, business_id, viewed_on, count)
  VALUES (gen_random_uuid(), target_business, CURRENT_DATE, 1)
  ON CONFLICT (business_id, viewed_on)
  DO UPDATE SET count = menu_views.count + 1;
END;
$$;

GRANT EXECUTE ON FUNCTION record_menu_view(text) TO menu_app;
