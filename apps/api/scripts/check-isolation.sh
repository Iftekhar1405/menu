#!/usr/bin/env bash
#
# Cross-tenant adversarial check, run against a live API.
#
# This is the one bug class in a multi-tenant menu platform that is genuinely
# unrecoverable: if one restaurant can read or write another's menu, there is
# no fixing it after the fact. So it gets proof rather than confidence.
#
# Two isolation layers are meant to stop this — a repository layer where
# businessId can only come from an ownership check, and Postgres RLS keyed to
# a per-transaction app.current_user_id. This exercises both from the outside,
# over real HTTP, as a real second tenant.
#
# Usage: bash scripts/check-isolation.sh [api-url]
# Exits non-zero if any attack path returns 2xx.

set -uo pipefail
API="${1:-http://localhost:4000}"
FAILURES=0

rand_phone() { echo "+9198$(shuf -i 10000000-99999999 -n 1)"; }
rand_email() { echo "iso$(date +%s)$RANDOM@example.test"; }

json_field() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

signup() { # name, identifier, pin
  curl -s -X POST "$API/auth/signup" -H 'Content-Type: application/json' \
    -d "{\"identifier\":\"$2\",\"pin\":\"$3\",\"fullName\":\"$1\",\"businessName\":\"$1 Place\",\"businessType\":\"cafe\",\"country\":\"IN\"}"
}

echo "Creating two tenants…"
A_TOKEN=$(signup "Tenant A" "$(rand_email)" "482913" | json_field '["accessToken"]')
B_TOKEN=$(signup "Tenant B" "$(rand_phone)" "771122" | json_field '["accessToken"]')

A_BID=$(curl -s "$API/businesses/mine" -H "Authorization: Bearer $A_TOKEN" | json_field '[0]["id"]')
B_BID=$(curl -s "$API/businesses/mine" -H "Authorization: Bearer $B_TOKEN" | json_field '[0]["id"]')

if [ -z "$A_BID" ] || [ -z "$B_BID" ]; then
  echo "FAILED: could not create both tenants" >&2
  exit 1
fi
echo "  A = $A_BID"
echo "  B = $B_BID"
echo

probe () { # description, expected-not-2xx, curl args...
  local desc="$1"; shift
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [ "${status:0:1}" = "2" ]; then
    printf '  LEAK  %-46s -> %s\n' "$desc" "$status"
    FAILURES=$((FAILURES + 1))
  else
    printf '  ok    %-46s -> %s\n' "$desc" "$status"
  fi
}

echo "Tenant B against tenant A — every line must be refused:"
probe "read A's menu" "$API/businesses/$A_BID/menu" -H "Authorization: Bearer $B_TOKEN"
probe "read A's dashboard summary" "$API/businesses/$A_BID/summary" -H "Authorization: Bearer $B_TOKEN"
probe "rename A's business" -X PATCH "$API/businesses/$A_BID" -H "Authorization: Bearer $B_TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"PWNED"}'
probe "add a category to A" -X POST "$API/businesses/$A_BID/categories" -H "Authorization: Bearer $B_TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"Injected","isVisible":true}'
probe "add an item to A" -X POST "$API/businesses/$A_BID/items" -H "Authorization: Bearer $B_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"X","categoryId":"00000000-0000-0000-0000-000000000000","price":1,"isAvailable":true,"allergens":[],"variants":[],"photos":[]}'
probe "download A's QR card" "$API/businesses/$A_BID/qr?format=png" -H "Authorization: Bearer $B_TOKEN"
probe "get an upload URL inside A" -X POST "$API/media/upload-url" -H "Authorization: Bearer $B_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"businessId\":\"$A_BID\",\"itemId\":\"00000000-0000-0000-0000-000000000000\"}"
probe "get a logo upload URL for A" -X POST "$API/businesses/$A_BID/logo/upload-url" -H "Authorization: Bearer $B_TOKEN"
echo

echo "Unauthenticated:"
probe "read A's menu with no token" "$API/businesses/$A_BID/menu"
echo

echo "Sanity — A must still reach A:"
OWN=$(curl -s -o /dev/null -w '%{http_code}' "$API/businesses/$A_BID/menu" -H "Authorization: Bearer $A_TOKEN")
if [ "$OWN" = "200" ]; then
  echo "  ok    owner reads own menu                          -> 200"
else
  echo "  BROKEN owner cannot read own menu                   -> $OWN"
  FAILURES=$((FAILURES + 1))
fi

echo
echo "Table sessions — the second principal:"

# Give tenant A two tables and take a session on each.
T1=$(curl -s -X POST "$API/businesses/$A_BID/tables" -H "Authorization: Bearer $A_TOKEN"   -H 'Content-Type: application/json' -d '{"label":"iso-1"}' | json_field '["token"]')
T2=$(curl -s -X POST "$API/businesses/$A_BID/tables" -H "Authorization: Bearer $A_TOKEN"   -H 'Content-Type: application/json' -d '{"label":"iso-2"}' | json_field '["token"]')

S1=$(curl -s -X POST "$API/public/tables/resolve" -H 'Content-Type: application/json'   -d "{\"token\":\"$T1\"}" | json_field '["sessionToken"]')

# A table session must not work anywhere in the owner surface.
probe "table session reads the owner's menu"  "$API/businesses/$A_BID/menu" -H "Authorization: Bearer $S1"
probe "table session lists the order board"   "$API/businesses/$A_BID/orders" -H "Authorization: Bearer $S1"
probe "table session lists tables"            "$API/businesses/$A_BID/tables" -H "Authorization: Bearer $S1"
probe "table session downloads the QR"        "$API/businesses/$A_BID/qr?format=png" -H "Authorization: Bearer $S1"

# An owner token must not work on the diner surface either. The two are
# different token types signed with different keys, so neither verifies as
# the other rather than relying on a scope check.
probe "owner token on the diner order route"  "$API/public/table/order" -H "Authorization: Bearer $A_TOKEN"
probe "owner token on the diner menu route"   "$API/public/table/menu" -H "Authorization: Bearer $A_TOKEN"

# A forged or truncated session must be refused outright.
probe "tampered table session"                "$API/public/table/order" -H "Authorization: Bearer ${S1%?}x"
probe "no session at all"                     "$API/public/table/order"

# A session for table 1 must only ever see table 1. There is no parameter to
# point it elsewhere, which is the point — confirm the only order it can read
# is its own.
curl -s -o /dev/null -X POST "$API/public/table/order" -H "Authorization: Bearer $S1"   -H 'Content-Type: application/json' -d '{"items":[]}' || true

S2=$(curl -s -X POST "$API/public/tables/resolve" -H 'Content-Type: application/json'   -d "{\"token\":\"$T2\"}" | json_field '["sessionToken"]')
SEEN=$(curl -s "$API/public/table/order" -H "Authorization: Bearer $S2")
if [ "$SEEN" = "null" ] || [ -z "$SEEN" ]; then
  echo "  ok    table 2 sees only its own (empty) order"
else
  echo "  LEAK  table 2 sees an order it did not place: $SEEN"
  FAILURES=$((FAILURES + 1))
fi

echo
echo "Bills and ratings:"

probe "table session reads the owner's bill list"  "$API/businesses/$A_BID/bills" -H "Authorization: Bearer $S1"
probe "table session reads tax config"             "$API/businesses/$A_BID/tax" -H "Authorization: Bearer $S1"
probe "table session reads the ratings"            "$API/businesses/$A_BID/ratings" -H "Authorization: Bearer $S1"
probe "table session changes tax config" -X PATCH  "$API/businesses/$A_BID/tax" -H "Authorization: Bearer $S1"   -H 'Content-Type: application/json' -d '{"taxEnabled":true,"defaultTaxRate":0}'
probe "owner token on the diner bill route"        "$API/public/table/bill" -H "Authorization: Bearer $A_TOKEN"
probe "owner token on the diner rating route"      "$API/public/table/rating" -H "Authorization: Bearer $A_TOKEN"
probe "no session on the diner bill route"         "$API/public/table/bill"

# Tenant B must not reach tenant A's billing surface either.
probe "tenant B reads A's bills"                   "$API/businesses/$A_BID/bills" -H "Authorization: Bearer $B_TOKEN"
probe "tenant B reads A's ratings"                 "$API/businesses/$A_BID/ratings" -H "Authorization: Bearer $B_TOKEN"
probe "tenant B rewrites A's tax config" -X PATCH  "$API/businesses/$A_BID/tax" -H "Authorization: Bearer $B_TOKEN"   -H 'Content-Type: application/json' -d '{"taxEnabled":false}'

# A table with no billed order must see nothing rather than someone else's.
SEEN_BILL=$(curl -s "$API/public/table/bill" -H "Authorization: Bearer $S2")
if [ "$SEEN_BILL" = "null" ] || [ -z "$SEEN_BILL" ]; then
  echo "  ok    table 2 sees no bill it did not incur"
else
  echo "  LEAK  table 2 sees a bill: $SEEN_BILL"
  FAILURES=$((FAILURES + 1))
fi

echo
echo "Platform admin — the one boundary that is crossed on purpose:"

# An ordinary owner must not reach the admin area at all.
probe "owner lists all merch orders"       "$API/admin/merch/orders" -H "Authorization: Bearer $A_TOKEN"
probe "owner reads an admin merch order"   "$API/admin/merch/orders/00000000-0000-0000-0000-000000000000" -H "Authorization: Bearer $A_TOKEN"
probe "owner pulls admin print artwork"    "$API/admin/merch/orders/00000000-0000-0000-0000-000000000000/artwork" -H "Authorization: Bearer $A_TOKEN"
probe "owner edits an admin merch order" -X PATCH "$API/admin/merch/orders/00000000-0000-0000-0000-000000000000"   -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' -d '{"status":"shipped"}'
probe "table session reaches the admin area" "$API/admin/merch/orders" -H "Authorization: Bearer $S1"
probe "no token on the admin area"           "$API/admin/merch/orders"

# Tenant B must not read tenant A's merch requests either.
probe "tenant B reads A's merch orders"    "$API/businesses/$A_BID/merch-orders" -H "Authorization: Bearer $B_TOKEN"

# The admin's reach is deliberately narrow: merch, plus business identity and
# tables to fulfil. Everything else must still be closed to us.
ADMIN_TOKEN=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json'   -d "{\"identifier\":\"${SEED_ADMIN_EMAIL:-admin@irad.solutions}\",\"pin\":\"${SEED_ADMIN_PIN:-204815}\",\"country\":\"IN\"}"   | json_field '["accessToken"]' 2>/dev/null || echo "")

if [ -n "$ADMIN_TOKEN" ]; then
  probe "admin reads a business's menu"      "$API/businesses/$A_BID/menu" -H "Authorization: Bearer $ADMIN_TOKEN"
  probe "admin reads a business's orders"    "$API/businesses/$A_BID/orders" -H "Authorization: Bearer $ADMIN_TOKEN"
  probe "admin reads a business's bills"     "$API/businesses/$A_BID/bills" -H "Authorization: Bearer $ADMIN_TOKEN"
  probe "admin reads a business's ratings"   "$API/businesses/$A_BID/ratings" -H "Authorization: Bearer $ADMIN_TOKEN"

  ADMIN_LIST=$(curl -s -o /dev/null -w '%{http_code}' "$API/admin/merch/orders" -H "Authorization: Bearer $ADMIN_TOKEN")
  if [ "$ADMIN_LIST" = "200" ]; then
    echo "  ok    admin can list merch orders                  -> 200"
  else
    echo "  BROKEN admin cannot list merch orders              -> $ADMIN_LIST"
    FAILURES=$((FAILURES + 1))
  fi
else
  echo "  skip  admin checks (seed not run: pnpm db:seed)"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "PASS — no cross-tenant access."
  exit 0
fi
echo "FAIL — $FAILURES path(s) leaked." >&2
exit 1
