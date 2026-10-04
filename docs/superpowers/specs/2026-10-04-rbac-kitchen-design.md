# RBAC: kitchen staff accounts

Date: 2026-10-04
Branch: `feat/rbac-kitchen-qr-logo`

## The problem

A venue is one login. The owner's PIN opens billing, settings, the menu
builder and the order board alike, so the person working the pass either
holds the owner's credential or does not touch the system. Both answers are
bad: the first makes the owner's account a shared kitchen password, and the
second means orders are driven by whoever happens to be near the till.

This adds a second kind of account — **kitchen** — that can work a service
and nothing else.

## What a kitchen user can do

| | kitchen | owner |
|---|---|---|
| See the live order board | yes | yes |
| Move an order to accepted / preparing / ready | yes | yes |
| Mark an order completed | **no** | yes |
| Cancel an order or a line | **no** | yes |
| See prices, totals, bills | **no** | yes |
| See dishes | yes | yes |
| Toggle dish availability | yes | yes |
| Edit a dish, price, photo or category | **no** | yes |
| Tables, QR, printed cards, menu design, settings, billing | **no** | yes |
| Manage staff | **no** | yes |

`completed` is withheld because it is what closes an order for billing — a
service act, not a kitchen one. Cancellation is withheld because it rewrites
a bill. Both are deliberate and both were chosen by the product owner.

"Admin" in the original request maps to the **existing `owner` role**. No new
administrator tier is introduced, and `platform_admin` is untouched.

## Decisions taken, and what they cost

**Staff log in with email or phone and a PIN, exactly like owners.** No new
authentication surface: the existing login screen, token service and lockout
policy all apply unchanged. The cost is that an identifier is globally unique,
so one person cannot yet be kitchen staff at two venues, and the venue stores
a staff member's personal contact detail. `business_staff` is shaped to allow
multi-venue later; the "is this the same human?" confirmation flow is not
built now, because getting it wrong leaks whether a given phone number has an
account.

**Owner-created, not invited.** There is no transactional email or SMS
configured for this path (`RESEND_API_KEY` and the WhatsApp credentials are
unset; `AUTH_SKIP_VERIFICATION` is true). An account whose first use depends
on an OTP that may never arrive is an account that does not work on day one.
The owner enters a name and an identifier, the system mints a starting PIN and
shows it once, and the owner hands it over. `verified_at` is set at creation:
the owner is the verification.

**Kitchen RLS policies sit beside the owner policies rather than replacing
them.** The alternative — one membership table and a single rewritten
predicate across all fifteen `%_owner` policies — is tidier and was rejected
by the product owner in favour of the smaller, lower-risk diff. The accepted cost is two
parallel rules per table, which is the exact shape where a later feature
updates one and forgets the other. Mitigation is specified below and is not
optional.

## Schema

```prisma
enum StaffRole   { kitchen }
enum StaffStatus { active suspended }

model BusinessStaff {
  id         String      @id @default(uuid()) @db.Uuid
  businessId String      @map("business_id") @db.Uuid
  userId     String      @map("user_id") @db.Uuid
  role       StaffRole   @default(kitchen)
  status     StaffStatus @default(active)
  /// Which owner added them. Kept when that owner is deleted, so the audit
  /// trail does not lose its author.
  createdById String?    @map("created_by_id") @db.Uuid
  createdAt  DateTime    @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt  DateTime    @updatedAt @map("updated_at") @db.Timestamptz(6)

  business Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  user     User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([businessId, userId])
  @@map("business_staff")
}
```

`UserRole` gains `kitchen`. It stays the platform-level answer to "what kind
of account is this". `JwtStrategy.validate` already re-reads the user row on
every request, so a role change or a deletion takes effect on the **next
request**, not when the 15-minute token expires.

`User` gains `mustChangePin Boolean @default(false)`, set true for
owner-created accounts.

`OrderEvent` gains `actorId String? @db.Uuid` — null means a diner or the
system. Existing rows backfill to null, which is honest: we do not know who
moved them.

### Indexes

```sql
CREATE INDEX business_staff_lookup
  ON business_staff (user_id, status) INCLUDE (business_id);
CREATE INDEX order_events_actor_idx
  ON order_events (actor_id, id DESC);
```

The first is load-bearing. Its columns are the predicate of every kitchen
policy, evaluated against ten tables on every request a kitchen user makes.

## Database isolation

### The helper

```sql
CREATE OR REPLACE FUNCTION app_staff_business_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT business_id FROM business_staff
   WHERE user_id = app_current_user_id() AND status = 'active'
$$;

REVOKE EXECUTE ON FUNCTION app_staff_business_ids() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION app_staff_business_ids() TO menu_app;
```

`SECURITY DEFINER` so it can read `business_staff` while that table's own
policies hide it; `SET search_path = public` to close search-path hijacking,
matching the convention the existing 33 functions already use. The identity
check is inside the function body, so it cannot be asked about another user.

Called as `business_id IN (SELECT app_staff_business_ids())` — an
uncorrelated subquery, so Postgres evaluates it **once per query as an
InitPlan**, not once per row.

### Policies

Read-only (`FOR SELECT`) on: `businesses`, `tables`, `orders`, `order_items`,
`menu_categories`, `menu_items`, `menu_item_variants`, `menu_item_photos`,
`order_events`, `notifications`.

```sql
CREATE POLICY <table>_kitchen_read ON <table> FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));
```

`businesses` is the exception and must not be written from that template: it
has no `business_id` column, because it *is* the business. Its policy keys on
the primary key instead, which is also how `businesses_owner` differs from
every other owner policy:

```sql
CREATE POLICY businesses_kitchen_read ON businesses FOR SELECT
  USING (id IN (SELECT app_staff_business_ids()));
```

Write (`FOR UPDATE`) on exactly two: `orders` and `menu_items`. No INSERT and
no DELETE policy for kitchen anywhere.

Deliberately given nothing: `bills`, `bill_lines`, `order_ratings`,
`order_item_cancellations`, `merch_orders`, `merch_order_items`, `menu_views`,
`users`, `refresh_tokens`, `otp_challenges`, `push_subscriptions` (already
self-scoped by `user_id`), `review_prompts`. Money is invisible at the
database, not merely in the UI.

`business_staff` itself: owners read and write rows for businesses they own;
a staff member may read only their own row.

### Column guards

RLS grants access to a *row*, never to a column, and a policy cannot compare
`OLD` with `NEW` (`USING` sees old, `WITH CHECK` sees new). So a kitchen
`UPDATE` policy on `orders` would otherwise permit writing `business_day`,
`is_running` or `note`. A `BEFORE UPDATE` trigger closes this:

- On `orders`: if the caller is active kitchen staff for the row's business,
  require `NEW.status IN ('accepted','preparing','ready')` and require every
  other column to equal its old value.
- On `menu_items`: same shape, with `is_available` as the only writable
  column.

Columns are compared explicitly, one by one, rather than through `hstore` or
`to_jsonb` — one fewer extension, and an explicit list fails loudly when
someone adds a column instead of silently letting it through.

### The drift guard

Because the two policy sets are parallel, a test asserts that **each of the
fifteen `%_owner` policies has either a kitchen counterpart or an entry in an
explicit `KITCHEN_DENIED` list** — and that the count is still fifteen, so a
new owner policy cannot appear unnoticed. A new table added later cannot quietly
inherit owner-only access; it forces a decision. This is the agreed mitigation
for the chosen policy approach and ships with it, not after it.

`scripts/check-isolation.sh` gains a third actor: tenant A's kitchen user,
probing tenant B's orders and its own venue's bills. Both must fail.

## API

### The chokepoint

`BusinessesService.assertOwns` is the single door through which a business id
becomes usable — 41 call sites. It becomes a thin wrapper:

```ts
assertAccess(userId, businessId, { allow: ["owner"] })   // the default
```

All 41 existing call sites keep owner-only behaviour with no edit. Only these
opt into `allow: ["owner", "kitchen"]`:

| Route | Kitchen |
|---|---|
| `GET /businesses/mine` | own venues only |
| `GET /businesses/:id/orders` | prices stripped |
| `PATCH /businesses/:id/orders/:id/status` | restricted targets |
| `GET /businesses/:id/orders/:id/events` | read |
| `GET /businesses/:id/menu` | prices stripped |
| `PATCH /businesses/:id/menu/items/:id/availability` | write |
| `GET /businesses/:id/tables` | read, for board labels |
| `GET /businesses/:id/notifications` + push subscribe | read |

Forgetting to touch a route leaves it owner-only. That is the failure
direction this codebase already prefers everywhere else.

`assertAccess` returns `{ business, role }`, so handlers shape their response
from the role rather than re-deriving it.

### Prices

The board currently returns `unitPrice` on every line and the client sums it
into a per-order total. For a kitchen caller the API **omits `unitPrice`
entirely**, and `GET /menu` omits `price`, variant prices and `taxRate`.
Hiding money in the client is not hiding money.

### Status rules

`packages/shared` gains, beside `ALLOWED_TRANSITIONS`:

```ts
export const ROLE_TARGETS: Record<StaffRole | "owner", OrderStatus[]> = {
  owner:   [...ORDER_STATUSES],
  kitchen: ["accepted", "preparing", "ready"],
};
```

Shared rather than API-only because the board needs the same table to decide
which buttons to draw; a UI offering a button the API rejects is worse than no
button. The service requires `canTransition(from, to) && ROLE_TARGETS[role].includes(to)`.
Both tables are pure data and unit-tested together.

### Staff management (owner only)

```
GET    /businesses/:id/staff
POST   /businesses/:id/staff           { fullName, identifier } -> { staff, pin }
PATCH  /businesses/:id/staff/:staffId  { status }
POST   /businesses/:id/staff/:staffId/reset-pin -> { pin }
DELETE /businesses/:id/staff/:staffId
```

`POST` creates the `User` and the `BusinessStaff` row in one transaction,
mints a random six-digit PIN, sets `mustChangePin`, and returns the PIN
**once**. It is never stored in plaintext and never retrievable again; reset
mints a new one.

Suspend, remove and reset-PIN each call `TokenService.revokeAllForUser`, so
access ends at once rather than when a token expires.

Rate-limited per business, and the identifier conflict message is the same
wording signup already uses, so this endpoint cannot be used to probe which
phone numbers have accounts.

### Audit

The existing `AFTER UPDATE` trigger on `orders` writes an `order_events` row
for every status change. It runs inside the request transaction, where
`app_current_user_id()` is already set, so it stamps `actor_id` at no cost.

Without this, individual staff logins buy nothing: you would know an order was
marked ready but not by whom, and the case for per-person accounts over one
shared tablet PIN collapses.

## Web

`Me.role` widens to `"owner" | "kitchen" | "platform_admin"`.

**Navigation is derived, not filtered.** `NAV` is currently a flat array of
nine with `ADMIN_NAV` appended for platform admins. A kitchen user needs a
*different* list, not a longer one:

```ts
const NAV_FOR: Record<Role, NavItem[]> = {
  owner:          [...OWNER_NAV],
  kitchen:        [ORDERS, DISHES],
  platform_admin: [...OWNER_NAV, ...ADMIN_NAV],
};
```

**There is no `middleware.ts`** — routing is client-side only. `Shell` gains a
redirect to `/orders` when the current path is not in the user's nav. This is
cosmetic; the real boundary is the API and RLS.

**The order board is reused, not forked.** `COLUMNS` already encodes
`next`/`nextLabel` per lane. Kitchen loses any `next` outside `ROLE_TARGETS`,
which removes **Served** from the Ready lane and the cancel action everywhere.
All four columns still render, so the kitchen can see what is ready and
waiting.

**Money disappears by following the data.** `unitPrice` becomes optional on
the client type and the total renders only when present — one rule, the
server's, rather than a second client rule that can drift from it.

**`/dishes`** is a new kitchen page: categories and items with an availability
toggle and nothing else. Deliberately not the existing menu builder behind a
`canEdit` flag — that page is dense with prices, variants and photo uploads,
and threading a flag through it is how a price leaks back in six months.

**Settings → Staff** is a new owner page: list, add, suspend, reactivate,
remove, reset PIN. Adding shows the generated PIN once, with a copy button and
a plain warning that it will not be shown again.

**Forced PIN change.** `me.mustChangePin` gates the shell ahead of everything
else. Until it clears, the owner knows the staff member's credential and the
audit trail means nothing.

**Notifications work unchanged.** `NotificationsProvider` is already keyed by
business and `push_subscriptions` is self-scoped by `user_id`, so a kitchen
tablet gets its own subscription and its own alerts with no new plumbing.

## Testing

- **Unit**: `ROLE_TARGETS` × `ALLOWED_TRANSITIONS` matrix; every pair asserted
  for both roles.
- **Policy**: for each of the ten readable tables, a kitchen user sees their
  venue's rows and zero rows of another venue. For each denied table, zero.
- **Column guard**: kitchen updating `orders.note` or `menu_items.price`
  raises; updating `status` / `is_available` succeeds.
- **Drift guard**: every `%_owner` policy has a kitchen counterpart or an
  explicit denial.
- **Price stripping**: kitchen responses from the board and `GET /menu`
  contain no price field at any depth.
- **Isolation script**: kitchen actor added to `scripts/check-isolation.sh`.
- **E2E**: owner creates staff → staff logs in → forced PIN change → moves an
  order to ready → cannot mark it served → toggles a dish unavailable →
  cannot reach `/billing`.

## Out of scope

Multi-venue staff; a waiter or manager role; per-user permission overrides;
staff shift or attendance tracking; staff-initiated cancellation; self-service
PIN recovery for staff (the owner resets it).

## Risks

**The parallel policy sets will drift.** Accepted by the product owner. The
drift-guard test is the mitigation and must not be deleted or skipped.

**`business_staff` is in the hot path of every kitchen query.** Mitigated by
the covering index and by the InitPlan-shaped subquery. Worth an `EXPLAIN` on
the dev replica once real policies exist.

**An owner can create an account against any phone number they type.** They
learn nothing (the conflict message matches signup's), but they can create an
account a stranger could later be told to use. Forced PIN change limits the
window; rate limiting bounds abuse.

## Related, found while surveying — not part of this work

1. `REALTIME_CHANNEL_SECRET` is unset in production, so it runs on the schema
   default `"dev-realtime-channel-secret"`. That key is the HMAC for Realtime
   topic names; with a publicly known key, anyone who reads a business id from
   a dashboard URL can compute the topic and subscribe to that venue's live
   order feed. This is a live exposure and should be fixed ahead of this work.
2. `qr.service.ts:20` hardcodes `https://menu.irad.solutions` and ignores
   `PUBLIC_MENU_BASE_URL`, so QR codes generated outside production encode
   production URLs and the table-scan flow cannot be tested on dev.
3. Production is one migration behind the repo
   (`20261001000000_amber_default_accent`), so deploying this work will apply
   two migrations.
4. QR card logos were already fully implemented (Settings → logo → **Save**).
   The original request's first item needed no work. A logo *inside* the code
   — error correction is already level H to allow it — remains unbuilt and
   unrequested.
