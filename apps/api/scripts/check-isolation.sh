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
if [ "$FAILURES" -eq 0 ]; then
  echo "PASS — no cross-tenant access."
  exit 0
fi
echo "FAIL — $FAILURES path(s) leaked." >&2
exit 1
