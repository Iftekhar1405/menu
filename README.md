# menu.irad.solutions

A multi-tenant digital menu platform for restaurants, cafes, and movie theatres.
An owner signs up with a 6-digit PIN, builds a menu, picks a design, and
downloads a print-ready QR card. Diners scan it and read the menu.

**Phase 1 is what's built.** Table ordering, billing/GST, post-order reviews, and
the PVC/epoxy QR storefront are specified but not implemented — see
`docs/superpowers/specs/2026-08-30-menu-platform-phase1-design.md` §11 for the
seams they attach to.

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
pnpm --filter @menu/api test:isolation   # cross-tenant, merge gate
pnpm --filter @menu/web e2e              # signup → menu → design → QR → diner
pnpm lint                                # typecheck all three packages
```

The e2e run writes screenshots to `apps/web/e2e/shots/`.
