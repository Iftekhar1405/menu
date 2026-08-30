# menu.irad.solutions

A multi-tenant digital menu platform for restaurants, cafes, and movie theatres.
An owner signs up with a 6-digit PIN, builds a menu, picks a design, and
downloads a print-ready QR card. Diners scan it and read the menu.

Diners at a table scan that table's card and order from it; staff work those
orders on a live board.

**Phases 1 and 2 are built.** Billing/GST, post-order Google reviews, and the
PVC/epoxy QR storefront are specified but not implemented — see
`docs/superpowers/specs/2026-08-30-menu-platform-phase1-design.md` §11.

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
4. Rotate `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `REVALIDATE_SECRET`.
5. Seed the platform admin: `pnpm db:seed`.

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
