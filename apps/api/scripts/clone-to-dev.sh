#!/usr/bin/env bash
#
# Rebuild the DEV database from a production snapshot.
#
# Re-cloning is a normal part of working on anything that touches RLS: a
# policy migration is rarely right the first time, and the only honest way to
# retest it is against the schema it will actually meet. So this is a script
# rather than a page of instructions someone follows differently each time.
#
# What it does, in order: dump prod's public schema, drop and recreate dev's,
# restore, create the app role and its grants, scrub every piece of personal
# data, and set one known PIN. Then it proves the result is faithful rather
# than assuming it.
#
# Usage: bash scripts/clone-to-dev.sh
#   PROD_DIRECT  overrides the source (default: DIRECT_URL from .env.prod/.env)
#   DEV_DIRECT   overrides the target (default: DIRECT_URL from .env.dev)
#
# Requires pg_dump/pg_restore at least as new as the prod server.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DEV_PIN_HASH='$argon2id$v=19$m=65536,t=3,p=1$b21EJBaSdwgAwiZnnEfLPw$+/RSR8vvY0IgpAbDaouQXxm/P0aA7l9BXZfIkSGxVvg'  # 123456
DEV_PIN='123456'

# Read one key out of an env file. Not `source`: the pooler URLs contain a
# literal & and a shell parses that as a background job, not a query string.
env_value() { grep -m1 "^$2=" "$ROOT/$1" 2>/dev/null | cut -d= -f2- || true; }

PROD_DIRECT="${PROD_DIRECT:-$(env_value .env.prod DIRECT_URL)}"
[ -n "$PROD_DIRECT" ] || PROD_DIRECT="$(env_value .env DIRECT_URL)"
DEV_DIRECT="${DEV_DIRECT:-$(env_value .env.dev DIRECT_URL)}"

[ -n "$PROD_DIRECT" ] || { echo "No source DIRECT_URL found (.env.prod or .env)" >&2; exit 1; }
[ -n "$DEV_DIRECT"  ] || { echo "No target DIRECT_URL found (.env.dev)" >&2; exit 1; }

# The one mistake this script must never make. Everything below drops a
# schema, so being pointed at the source would destroy production outright.
if [ "$PROD_DIRECT" = "$DEV_DIRECT" ]; then
  echo "REFUSING: source and target are the same database." >&2
  exit 1
fi

host_of() { printf '%s\n' "$1" | sed -E 's#^[^@]*@##; s#/.*$##'; }
echo "  source  $(host_of "$PROD_DIRECT")   (read-only)"
echo "  target  $(host_of "$DEV_DIRECT")    (WILL BE ERASED)"
read -r -p "Type 'erase dev' to continue: " reply
[ "$reply" = "erase dev" ] || { echo "Aborted."; exit 1; }

DUMP="$(mktemp -t menu-prod-XXXXXX).dump"
trap 'rm -f "$DUMP"' EXIT

# Port 5432, never the 6543 pooler: pg_dump needs a session for its snapshot
# and cannot get one through pgbouncer in transaction mode. --schema=public
# keeps Supabase's own auth/storage/realtime schemas and roles out of it.
echo "==> Dumping production"
pg_dump "$PROD_DIRECT" \
  --schema=public --no-owner --no-privileges \
  --no-publications --no-subscriptions \
  -Fc -f "$DUMP"

echo "==> Resetting dev schema"
psql "$DEV_DIRECT" -v ON_ERROR_STOP=1 -q \
  -c 'DROP SCHEMA public CASCADE;' -c 'CREATE SCHEMA public;'

echo "==> Restoring"
pg_restore --no-owner --no-privileges -d "$DEV_DIRECT" "$DUMP"

# The dump carried no roles and no privileges, so without this the API starts
# and then fails every query with a permission error that reads nothing like
# a permission problem. The DEFAULT PRIVILEGES lines matter just as much:
# they are what grants tables that future migrations have not created yet.
echo "==> Creating menu_app and granting"
psql "$DEV_DIRECT" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='menu_app') THEN
    CREATE ROLE menu_app LOGIN PASSWORD 'menu_app_dev_2026';
  ELSE
    ALTER ROLE menu_app LOGIN PASSWORD 'menu_app_dev_2026';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO menu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO menu_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO menu_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO menu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO menu_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO menu_app;
SQL

# Real diners' and owners' contact details are the same personal data here as
# in production, with dev-grade access control around them. They do not get to
# sit in a second project untouched.
echo "==> Scrubbing personal data"
psql "$DEV_DIRECT" -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;
UPDATE users SET
  email     = CASE WHEN email IS NULL THEN NULL ELSE 'user' || left(id::text,8) || '@example.test' END,
  phone     = CASE WHEN phone IS NULL THEN NULL ELSE '+9199' || lpad((abs(hashtext(id::text)) % 100000000)::text, 8, '0') END,
  full_name = 'Test User ' || left(id::text, 8),
  pin_hash  = '${DEV_PIN_HASH}',
  failed_attempts = 0,
  locked_until = NULL,
  verified_at = COALESCE(verified_at, now());

UPDATE merch_orders SET
  contact_name = 'Test Contact', contact_phone = '+919900000000',
  contact_email = NULL, address_line1 = 'Test address', address_line2 = NULL,
  notes = NULL, admin_notes = NULL;

UPDATE order_ratings SET private_feedback = NULL;
COMMIT;
SQL

echo "==> Verifying"
fail=0
check() { # label, actual, expected
  if [ "$2" = "$3" ]; then printf '    ok    %s = %s\n' "$1" "$2"
  else printf '    FAIL  %s = %s (expected %s)\n' "$1" "$2" "$3"; fail=1; fi
}

q() { psql "$1" -tAc "$2" | tr -d '[:space:]'; }

check "policies"  "$(q "$DEV_DIRECT" "select count(*) from pg_policies where schemaname='public'")" \
                  "$(q "$PROD_DIRECT" "select count(*) from pg_policies where schemaname='public'")"
check "rls forced" "$(q "$DEV_DIRECT" "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relforcerowsecurity")" \
                   "$(q "$PROD_DIRECT" "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relforcerowsecurity")"
check "real emails left" "$(q "$DEV_DIRECT" "select count(*) from users where email is not null and email not like '%@example.test'")" "0"
check "real phones left" "$(q "$DEV_DIRECT" "select count(*) from users where phone is not null and phone not like '+9199%'")" "0"

# The check that decides whether anything else here means anything. Every
# tenant table is FORCE ROW LEVEL SECURITY, so with no app.current_user_id the
# app role must see nothing at all. A non-zero count means the grants or the
# policies did not land, and every policy tested afterwards would appear to
# pass for the wrong reason.
APP_URL="$(env_value .env.dev APP_DATABASE_URL)"
if [ -n "$APP_URL" ]; then
  check "rows visible to menu_app without tenant context" "$(q "$APP_URL" 'select count(*) from businesses')" "0"
else
  echo "    skip  RLS check (no APP_DATABASE_URL in .env.dev)"
fi

[ "$fail" -eq 0 ] || { echo "Verification failed — do not use this database." >&2; exit 1; }

cat <<EOF

Dev database rebuilt. Every account's PIN is ${DEV_PIN}.
Apply migrations with:
  DIRECT_URL='<dev session url>' pnpm --filter @menu/api db:deploy
EOF
