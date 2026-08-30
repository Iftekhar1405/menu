# menu.irad.solutions

A multi-tenant digital menu platform for restaurants, cafes, and movie theatres.
An owner signs up with a 6-digit PIN, builds a menu, picks a design, and
downloads a print-ready QR card. Diners scan it and read the menu.

Diners at a table scan that table's card and order from it; staff work those
orders on a live board.

Staff close the order and the diner gets a bill they can download for 30
minutes, plus a 10-minute window to rate the meal.

Owners order printed PVC cards, epoxy tags and acrylic stands from us; only the
seeded platform admin can see those orders.

**All four phases are built.**

## Running it

Needs Node 22+, pnpm, and Docker (for local Postgres).

```bash
pnpm install
cp .env.example .env          # defaults work as-is for local development
pnpm db:up                    # Postgres on :5433
pnpm --filter @menu/shared build
pnpm db:migrate
pnpm dev                      # API on :4000, web on :3000
```

Open http://localhost:3000 and create an account.

**No credentials are needed to run this.** `AUTH_SKIP_VERIFICATION=true` marks
new accounts verified, OTPs are printed to the API console instead of being
sent, and uploads go to local disk instead of Supabase Storage. Every one of
those is a driver behind an interface, so switching to the real thing is an env
change rather than a code change.

## Layout

```
apps/api        NestJS + Prisma. Owns identity and all data access.
apps/web        Next.js 15. Owner dashboard and the public menu.
packages/shared Types and Zod schemas both sides validate against.
docs/superpowers/specs   Design spec
docs/superpowers/plans   Implementation plan
```

## How table ordering works

The brief asked for two things that look contradictory: a diner must order from
their table, and the ordering URL must not differ per table, "otherwise user
will be able to see other table order by changing the url."

The resolution separates the two roles that URL was playing. A table card
encodes `/t/<32-hex-token>` — a **claim**, not an address. Visiting it resolves
the token, sets a signed httpOnly cookie, and redirects to `/order`, which is
the same address for every table at every business. After that redirect there is
nothing in the address bar to tamper with, and no cookie means no table, which
is when the scanner opens.

The session is minted by the API but **set by Next and never given to client
JavaScript**; diner API calls are proxied through Next route handlers that read
the cookie server-side. Handing the token to the browser would put it where any
script could lift and replay it.

Two more things the database enforces rather than the application:

- **One open order per table**, via a partial unique index. Two phones at a
  table will tap "Place order" within milliseconds of each other; an
  application-level check loses that race and produces two bills.
- **Prices are read from the menu inside the transaction that writes the
  order.** The client sends item ids and quantities only. A client that could
  name its own prices could order a biryani for one rupee.

## Bills

**The bill is a receipt that shows tax, not a GST tax invoice.** It carries no
financial-year invoice sequence, no HSN codes, and no CGST/SGST split. A
GST-registered restaurant cannot hand this to a customer in place of the tax
invoice they are required to issue — the receipt and the billing settings page
both say so. Each line snapshots its own rate and tax amount, so becoming
compliant later is added columns rather than reinterpreting stored bills.

Three things that are easy to get wrong and are therefore fixed in the database:

- **Prices are tax-inclusive by default.** Most Indian menus are priced that way,
  and the wrong default in that direction overcharges every diner on every bill.
- **A bill is written once.** Regenerating returns the existing bill rather than
  recomputing it; snapshotting is pointless if a reprint can differ from the
  original.
- **The 30-minute and 10-minute windows are SQL predicates**, not checks in the
  API, and neither diner route takes a bill or order id. A session can reach
  exactly one bill — its own table's most recent, inside the window.

**Service charge is off by default and the diner can remove it from their own
bill.** Since the 2022 CCPA guidelines an automatic or mandatory service charge
is not permitted in India, and restaurants have been ordered to refund it. The
printed receipt carries the same statement the screen does.

**Review gating is deliberately not built.** The Google route and the private
feedback box are offered at every rating, and the seeded prompts for 1–3 stars
are honest ones. Showing Google only to happy diners violates Google's policies
and has cost businesses their review counts. Note also that no API can post a
review to Google on someone's behalf — copy-and-deep-link is the only mechanism
that exists.

## Printed cards, and the admin area

Owners request printed QR products; **only an account with
`role = 'platform_admin'` can see those requests**, and it is seeded by
`pnpm db:seed` from `SEED_ADMIN_*`. There is no payment gateway, so a request
is a request: we quote and take payment offline, and the owner-facing copy says
that rather than implying a checkout.

This is the one capability in the system that **deliberately crosses the tenant
boundary** — fulfilling an order means reading rows belonging to someone else.
The widening is kept as small as the job allows: a second clause on the three
`merch_*` tables, plus SELECT-only policies on `businesses` and `tables` so we
can address a parcel and print the cards. The admin still cannot read any
business's menu, orders, bills, or ratings, and the isolation suite asserts
exactly that.

`admin_notes` and internal costing are withheld in the API rather than by RLS,
which is row-level and cannot hide a column from someone entitled to the row.

Per-table products take table ids rather than a quantity. Each card carries a
different QR, so "20 cards" without saying which tables cannot be printed — and
the artwork download is a single PDF with one page per table, in table order.

## Two things worth knowing before changing anything

**Tenant isolation is enforced twice, and the second layer is easy to disable by
accident.** The API connects as `menu_app`, a non-superuser role. This matters:
superusers and table owners bypass row-level security entirely, so pointing
`APP_DATABASE_URL` at the migration role would silently turn every policy off
while all the tests still passed. Migrations run as the owner via
`DATABASE_URL`; the running app must not.

```bash
pnpm --filter @menu/api test:isolation   # two real tenants, eight attack paths
```

**Price lives at whichever level actually carries it.** An item has a base price
*or* variants with prices — never neither, never both. A deferred constraint
trigger enforces this at COMMIT, and the same rule is mirrored in the Zod schema
so owners get a readable message instead of a 500. A latte sold in three sizes
has no meaningful single price, and storing a placeholder there produces a wrong
bill once ordering lands.

## Going to production

1. Point `DATABASE_URL` at Supabase (migrations, as `postgres`) and create an
   equivalent non-superuser role for `APP_DATABASE_URL`.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to move uploads off local
   disk.
3. Set `WHATSAPP_*` (Meta Cloud API, approved authentication template) and
   `RESEND_API_KEY`, then set `AUTH_SKIP_VERIFICATION=false`.
4. Rotate `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `REVALIDATE_SECRET`, and
   `TABLE_SESSION_SECRET`.
5. Set a real `SEED_ADMIN_PIN`, then seed the platform admin and the
   merchandise catalogue: `pnpm db:seed`. The seed is idempotent and warns if
   the PIN is still the example value.

### One accepted risk, recorded deliberately

A 6-digit PIN is one million possibilities and is the only authentication
factor. Argon2id and per-account rate limiting contain online guessing, but a
database breach exposes credentials to offline attack quickly. This was raised
during design and chosen anyway, for login speed at a counter.

If that trade stops being worth it — most likely once billing data and order
history accumulate in Phase 3 — the fix is trusted-device binding: an OTP on
first use of a new device, PIN alone after that. The `otp_challenges` table and
the `NotificationChannel` interface already support it with no schema change.

## Tests

```bash
pnpm --filter @menu/api test:isolation   # cross-tenant + table sessions, merge gate
pnpm --filter @menu/web e2e              # owner flow, and scan → order → kitchen
pnpm lint                                # typecheck all three packages
```

The isolation check covers both principals: one tenant against another, and a
table session against the owner surface (and vice versa).

The e2e run writes screenshots to `apps/web/e2e/shots/`.
