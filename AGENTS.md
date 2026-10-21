# AGENTS.md

This file provides guidance to Codex (claude.ai/code) when working with code in this repository.

Multi-tenant digital menu platform (restaurants, cafes, cinemas): owners build a menu and print QR cards; diners scan to read, order from their table, get a bill, and rate; owners track sales and export bills for their accounts. README.md explains the *why* behind most design decisions — read the relevant section before changing ordering, billing, merch/admin, images, or auth.

## Commands

pnpm monorepo (Node 22+, pnpm 10). Packages: `@menu/api` (apps/api), `@menu/web` (apps/web), `@menu/shared` (packages/shared).

```bash
pnpm install
cp .env.example .env                 # defaults work locally, no external credentials needed
pnpm db:up                           # Postgres 16 in Docker on host port 5433
pnpm --filter @menu/shared build     # REQUIRED before api/web: they import shared's dist/
pnpm db:migrate                      # prisma migrate dev (as DATABASE_URL owner role)
pnpm db:seed                         # platform admin + merch catalogue (idempotent)
pnpm dev                             # API :4000, web :3000 (also runs shared in tsc --watch)
pnpm dev:api / pnpm dev:web

pnpm lint                            # = tsc --noEmit in every package (no ESLint)
pnpm test                            # vitest in all three packages
pnpm --filter @menu/api exec vitest run src/sales/sales-filter.sql.spec.ts   # single test file (same shape for web/shared)
pnpm --filter @menu/api test:isolation   # cross-tenant attack script against a LIVE API (bash + curl + python3)
pnpm --filter @menu/web e2e              # Playwright against running dev servers; screenshots -> apps/web/e2e/shots/
pnpm --filter @menu/web exec playwright test e2e/sales.spec.ts      # single e2e spec
pnpm --filter @menu/web icons            # regenerate favicon/touch icons from public/mark.svg
pnpm db:reset                            # drop + re-migrate
```

- Prisma reads `DATABASE_URL` **and** `DIRECT_URL` (schema `directUrl`); the CLI run inside `apps/api` does not load the root `.env` by itself — export it first (`set -a; . ../../.env; set +a`) and set `DIRECT_URL` to the same URL locally.
- `schema.prisma` currently drifts from the migrations on `order_events`/`notifications`/`push_subscriptions`, so `prisma migrate dev` stops at an interactive "name this migration" prompt. Apply hand-written migrations with `prisma migrate deploy` (or `reset`). **Never pass the dev database as `--shadow-database-url`** — Prisma wipes the shadow database.
- `test:isolation` is the merge gate for anything touching data access, auth, or RLS. `@menu/api`'s `test:e2e` script references a `vitest.e2e.config.ts` that does not exist.

## Architecture

**API (NestJS + Prisma)** owns identity and all data access. **Web (Next.js 15 App Router)** is the owner dashboard (`app/(app)`), auth pages (`app/(auth)`), public menu (`app/(public)/m/[code]`, `[slug]`), and diner ordering (`/t/[token]`, `/order`, `app/api/table/*`). **Shared** holds Zod schemas, enums, theme tokens, and the public-menu payload type that both sides validate against — there is no class-validator; API bodies use `new ZodBody(schema)` (`apps/api/src/common/zod.pipe.ts`), which returns `fieldErrors` the web forms map onto inputs. Change validation rules in `packages/shared`, then rebuild it.

**Deployment:** both apps deploy to Vercel. The API runs as one serverless function (`api/index.ts` → compiled `apps/api/dist/serverless.js`, `maxDuration: 30`, ~4.5 MB response cap) against Supabase's transaction pooler — long or large work must be split into small requests (see the sales export). `docs/deploy-vercel.md` has the details.

### Tenant isolation is enforced in two layers
1. **Application:** every owner route resolves its business via `BusinessesService.assertOwns(userId, businessId)`; a business id from the URL is never trusted alone.
2. **Postgres RLS:** the global `TenantInterceptor` wraps each authenticated request in a transaction that sets `app.current_user_id` (`prisma/tenant-context.ts`). The transaction client lives in AsyncLocalStorage, so services must query through **`this.prisma.db`**, not `this.prisma.<model>` directly — the base client runs on a different connection with no setting, so RLS denies everything. Use the base client only deliberately (public endpoints, uniqueness checks across tenants, seeds).
- The running API must connect as `menu_app` via `APP_DATABASE_URL` (non-superuser, created in the `hardening` migration). Pointing it at the owner role silently disables every policy while tests still pass. Migrations run as `DATABASE_URL`.
- RLS policies and DB-level invariants live in hand-written SQL inside `apps/api/prisma/migrations/*` — when adding a tenant table, add its policy and `menu_app` grants in the migration, and extend `scripts/check-isolation.sh`.

### Auth: two separate principals
- **Owner JWT** (`auth/`): 6-digit PIN login, Argon2id; 15-min access token held in a module variable in `apps/web/lib/api-client.ts` (never localStorage), refreshed via an httpOnly refresh cookie that lives on the web origin — `/auth/*` calls go through the same-origin proxy `app/api/auth/[...path]`. `JwtAuthGuard` and `RolesGuard` are global — routes are authenticated by default; opt out with `@Public()`, restrict with `@Roles('platform_admin')`.
- **Table session** (`tables/table-session.ts`): a different JWT signed with `TABLE_SESSION_SECRET`, checked by `TableSessionGuard` on `/public/table/*`. Neither token type verifies as the other. A table card encodes `/t/<token>`; Next resolves it, sets the httpOnly `menu_table` cookie, and redirects to `/order`. Client JS never sees the session — diner calls go through Next route handlers in `app/api/table/*` using `proxyTableRequest` (`apps/web/lib/table-session.ts`). New diner endpoints need both an API route and a proxy handler; diner routes never accept an order/bill id.

### Order statuses
`placed → accepted → preparing → ready → completed (Served) → paid`, plus `cancelled`. The state machine is `apps/api/src/orders/transitions.ts`. Status lists are **also written by hand in SQL**: *open* statuses in the `orders_one_open_per_table` index and `place_table_round`/`get_table_order`; *finished* statuses (`completed`, `paid`) in `place_table_round` (running-order window), `get_table_order` and `get_ratable_order`. Change `transitions.ts` and those together. Adding an enum value needs its own migration (Postgres can't use a new value in the transaction that added it). Status changes are logged to `order_events` by a trigger.

`paid` is set only by `POST businesses/:bid/orders/:id/paid` with a payment mode (cash/upi/card/other) — it bills the order if needed and stores `payment_mode`/`paid_at` on the bill. The owner can correct a paid bill's mode (logged as a `payment_mode_changed` event).

### Invariants enforced in the database (don't re-implement or bypass in app code)
- One open order per table (partial unique index).
- Prices are read from the menu inside the order-writing transaction; clients send item ids + quantities only.
- An item has a base price **xor** priced variants (deferred constraint trigger, mirrored in the shared Zod schema).
- Bills are written once and snapshot per-line tax; the 30-min bill and 10-min rating windows are SQL predicates. Prices are tax-inclusive by default; service charge is off by default and diner-removable — until the bill is paid (`remove_service_charge` refuses). The bill is a receipt, not a GST invoice. `payment_mode`/`paid_at` are both set or both null (CHECK).
- Platform admin is the only deliberate cross-tenant reach: `merch_*` tables plus SELECT on `businesses`/`tables`. Admin-only columns (`admin_notes`, costing) are stripped in the API, not RLS.

### Sales records & Insights
- One filter, `salesFilterSchema` (`packages/shared/src/sales.ts`), is parsed by every sales route and turned into SQL in exactly one place, `billWhere` (`apps/api/src/sales/sales-filter.sql.ts`); the list, the export and analytics all use it, so they always agree. All values are bind parameters.
- Reports use the business's local time from `timezoneFor(country)` (IN → Asia/Kolkata), not `orders.business_day` (which is computed in UTC). Financial year is April–March.
- The bill ZIP is assembled **in the browser** (`apps/web/lib/sales/export.ts`): rows come from `GET bills/export/rows` in 1000-bill pages, PDFs from `POST bills/export/pdfs` in 25-bill batches — the serverless API can't render a year of PDFs in one call. An export with any failed batch is aborted, never written partially.
- Filter state lives in the page URL (`components/sales/use-sales-filter.ts`); presets are re-evaluated against today.

### Other cross-cutting pieces
- **Public menu** is statically rendered and cached; owner saves call `RevalidateClient.menu(publicCode)` which POSTs to web `/api/revalidate` (shared `REVALIDATE_SECRET`, path must match `/m/<8 chars>`). Any service mutating menu/business display data must trigger it.
- **Menu templates** (`apps/web/components/templates/`): three layouts over one `PublicMenu` payload, shared by the read-only menu and the ordering page via a `renderAction` prop — don't fork a separate ordering list.
- **Pluggable drivers chosen by env:** images (Cloudinary > Supabase Storage > local disk at `apps/api/.uploads`; browser uploads directly with an API-minted ticket, bytes never pass through the API) and OTP delivery (`otp/channels/`: WhatsApp/email/console). With `AUTH_SKIP_VERIFICATION=true`, OTPs print to the API console. `notifications/` is the staff/diner order-notification feed (web push + realtime), not OTP.
- **PDFs/QR:** `qr/` renders cards as SVG (→ PNG via resvg, → PDF via pdfkit + svg-to-pdfkit); `billing/` renders bill and receipt PDFs as separate documents.
- **Brand:** the tenant's accent is the only colour in the interface; charts (`components/insights/`) are single-hue.

Design specs and implementation plans for each phase are in `docs/superpowers/`.
