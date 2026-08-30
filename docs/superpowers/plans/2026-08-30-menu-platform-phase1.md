# Menu Platform Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner can sign up with a 6-digit PIN, describe their business, build a menu with photos and variants, pick a template, and download a print-ready QR card that diners scan to view a fast, edge-cached menu.

**Architecture:** pnpm monorepo. `apps/api` is a NestJS + Prisma service owning all data access and identity. `apps/web` is Next.js 15 App Router — an authenticated owner dashboard plus an ISR-rendered public menu — that talks only to the API. Supabase provides Postgres and Storage; photo bytes go browser→Storage via signed URLs and never transit the API. Tenant isolation is enforced twice: a scoped repository layer where `businessId` comes only from the JWT, and Postgres RLS keyed to a per-transaction session variable.

**Tech Stack:** TypeScript throughout. NestJS 10, Prisma 5, Postgres (Supabase), Argon2id, Passport-JWT, Next.js 15, Tailwind 4, dnd-kit, Zod, `qrcode`, `@resvg/resvg-js`, `pdfkit`. Vitest + Jest + Supertest + Playwright.

**Spec:** `docs/superpowers/specs/2026-08-30-menu-platform-phase1-design.md`

## Global Constraints

- Login is **6-digit numeric PIN only**. No passwords anywhere in the system.
- A user has an email, a phone, or both — never neither. `CHECK (email IS NOT NULL OR phone IS NOT NULL)`.
- One OTP code is minted per challenge and fanned out to **every** channel the account has. Partial delivery failure is tolerated; only all-channels failure is an error.
- **Credentials are unavailable for this build.** `NotificationChannel` runs the `ConsoleDriver`, which logs the OTP instead of sending it. `AUTH_SKIP_VERIFICATION=true` marks accounts verified on signup. Real drivers stay behind the interface, unreferenced by business logic.
- `businessId` is **never** read from a request body, query string, or client-controlled URL parameter. It is derived from the JWT or validated against the caller's businesses.
- `public_code` is permanent and never editable — printed QR cards depend on it.
- Item price is nullable, guarded by a constraint requiring either a base price or at least one variant.
- Currency defaults to `INR`. Country defaults to `IN`.
- Public menu payload is served by one `SECURITY DEFINER` function; anonymous roles get no direct table access.
- Design: light-first, one accent colour, hierarchy from type and space, translucency on chrome only, 44px minimum targets, `prefers-reduced-motion` honoured. Dashboard springs ≤300ms.
- Watermark text on every QR asset: `menu.irad.solutions`.

---

## File Structure

```
apps/api/
  src/
    main.ts, app.module.ts
    prisma/                prisma.service.ts, tenant-context.ts
    common/                guards/, decorators/, filters/, dto/
    auth/                  auth.module|controller|service.ts, jwt.strategy.ts,
                           pin.service.ts, identifier.ts, throttle.store.ts
    otp/                   otp.module|service.ts, otp.repository.ts
    notifications/         notification.channel.ts, console.driver.ts,
                           whatsapp.driver.ts, email.driver.ts, dispatcher.ts
    users/                 users.module|service.ts
    businesses/            businesses.module|controller|service.ts, public-code.ts
    menu/                  categories.controller|service.ts,
                           items.controller|service.ts, menu.repository.ts
    media/                 media.module|controller|service.ts (signed URLs)
    qr/                    qr.module|controller|service.ts, card.svg.ts
    public/                public.controller|service.ts, revalidate.client.ts
  prisma/schema.prisma, prisma/migrations/, prisma/seed.ts
  test/                    isolation.e2e-spec.ts, auth.e2e-spec.ts, menu.e2e-spec.ts

apps/web/
  app/
    (auth)/signup, login, forgot-pin
    (app)/dashboard, menu, templates, settings, qr
    (public)/m/[code]/page.tsx
    api/revalidate/route.ts
  components/
    menu-builder/          category-list.tsx, item-sheet.tsx, advanced-details.tsx,
                           variant-editor.tsx, photo-uploader.tsx
    templates/             editorial.tsx, compact.tsx, grid.tsx, theme.ts
    ui/                    primitives
  lib/                     api-client.ts, session.ts, country.ts, image-resize.ts
  e2e/                     happy-path.spec.ts

packages/shared/           types.ts (DTO types shared by api + web), theme-tokens.ts
```

---

## Task 1: Monorepo scaffold

**Files:** Create `package.json`, `pnpm-workspace.yaml`, `.gitignore`, `.env.example`, `apps/api/*`, `apps/web/*`, `packages/shared/*`

- [ ] `git init`; `.gitignore` covering `node_modules`, `.next`, `dist`, `.env*` (not `.env.example`), `*.local`
- [ ] pnpm workspace with `apps/*` and `packages/*`
- [ ] `nest new` into `apps/api`; `create-next-app` (TS, Tailwind, App Router) into `apps/web`
- [ ] `packages/shared` exporting an empty `types.ts` barrel, referenced by both apps via workspace protocol
- [ ] Root scripts: `dev` (both apps), `build`, `test`, `lint`
- [ ] Commit: `chore: scaffold monorepo`

**Produces:** `@menu/shared` package alias; `apps/api` on :4000, `apps/web` on :3000.

---

## Task 2: Database schema, RLS, seed

**Files:** Create `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/`, `apps/api/prisma/seed.ts`, `apps/api/src/prisma/prisma.service.ts`, `apps/api/src/prisma/tenant-context.ts`

Models exactly as §5 of the spec: `User`, `OtpChallenge`, `Business`, `MenuCategory`, `MenuItem`, `MenuItemVariant`, `MenuItemPhoto`. Plus `MenuView` (`business_id`, `viewed_on date`, `count int`, unique on the pair) for the dashboard counter.

- [ ] Prisma schema with all models, enums (`BusinessType`, `DietTag`, `UserRole`, `OtpPurpose`), and indexes on every `business_id`
- [ ] Raw-SQL migration adding:
  - `CHECK (email IS NOT NULL OR phone IS NOT NULL)` on `users`
  - Deferred constraint trigger `menu_item_price_guard` on `menu_items` and `menu_item_variants` raising unless `price IS NOT NULL OR EXISTS (SELECT 1 FROM menu_item_variants v WHERE v.item_id = ...)`
  - RLS enabled on all tenant tables with policies reading `current_setting('app.current_user_id', true)::uuid`
  - `get_public_menu(p_code text) RETURNS jsonb` as `SECURITY DEFINER`, returning business identity, theme tokens, visible categories, available items with variants and photos, ordered by `position`
  - `REVOKE ALL ON ALL TABLES` from the anon role; `GRANT EXECUTE ON get_public_menu` to it
- [ ] `PrismaService` extending `PrismaClient`; `TenantContext` running each request in a transaction that issues `SET LOCAL app.current_user_id`
- [ ] **Test:** price guard rejects an item with neither price nor variants; accepts each valid shape
- [ ] `seed.ts` creating the platform admin from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PIN`
- [ ] Commit: `feat(db): schema, RLS policies, public menu function`

**Produces:** `PrismaService`, `withTenant(userId, fn)`, `get_public_menu(code)`.

---

## Task 3: PIN, identifiers, users

**Files:** Create `apps/api/src/auth/pin.service.ts`, `apps/api/src/auth/identifier.ts`, `apps/api/src/users/users.service.ts`

```ts
// identifier.ts
type Identifier = { kind: 'email'; email: string } | { kind: 'phone'; phone: string }
parseIdentifier(raw: string, defaultCountry: string): Identifier   // throws on invalid
// phone normalised to E.164 via libphonenumber-js

// pin.service.ts
hashPin(pin: string): Promise<string>          // argon2id; rejects non-/^\d{6}$/
verifyPin(pin: string, hash: string): Promise<boolean>
```

- [ ] **Test first:** `parseIdentifier` handles `user@x.com`, `9876543210` + `IN` → `+919876543210`, `+91 98765 43210`, and rejects `abc`, `12345`
- [ ] **Test first:** `hashPin` rejects `12345`, `1234567`, `abcdef`; `verifyPin` round-trips
- [ ] `UsersService.createUser`, `findByIdentifier`, `recordFailedAttempt`, `resetFailedAttempts`
- [ ] Commit: `feat(auth): PIN hashing and identifier parsing`

**Produces:** `parseIdentifier`, `hashPin`, `verifyPin`, `UsersService`.

---

## Task 4: OTP and notification fan-out

**Files:** Create `apps/api/src/notifications/*`, `apps/api/src/otp/*`

```ts
interface NotificationChannel {
  readonly name: 'whatsapp' | 'email'
  supports(user: UserContact): boolean
  sendOtp(user: UserContact, code: string, purpose: OtpPurpose): Promise<void>
}

class OtpService {
  issue(userId: string, purpose: OtpPurpose): Promise<{ dispatched: string[] }>
  verify(userId: string, purpose: OtpPurpose, code: string): Promise<boolean>
}
```

- [ ] `ConsoleDriver` implements both channel names, logs `[OTP] to <target>: <code>`. Selected whenever provider env vars are absent.
- [ ] `WhatsAppDriver` (Meta Cloud API, auth template) and `EmailDriver` (Resend) written but inert without credentials
- [ ] `Dispatcher.fanOut` sends the same code to every supporting channel via `Promise.allSettled`; resolves if ≥1 fulfils, throws `AllChannelsFailedError` only if none do
- [ ] **Test first:** one code reaches both channels; email failure + WhatsApp success resolves; both failing throws
- [ ] **Test first:** OTP is single-use, expires at 10 minutes, locks after 5 wrong attempts
- [ ] Commit: `feat(otp): single-code multi-channel dispatch`

**Produces:** `NotificationChannel`, `Dispatcher`, `OtpService`.

---

## Task 5: Auth endpoints

**Files:** Create `apps/api/src/auth/auth.controller.ts`, `auth.service.ts`, `jwt.strategy.ts`, `throttle.store.ts`, `apps/api/src/common/guards/*`

```
POST /auth/signup       { identifier, pin, fullName, businessName, businessType, country }
POST /auth/login        { identifier, pin }         -> { accessToken } + refresh cookie
POST /auth/refresh                                   -> rotates
POST /auth/logout
POST /auth/otp/request  { identifier, purpose }
POST /auth/otp/verify   { identifier, purpose, code }
POST /auth/pin/reset    { identifier, code, newPin }
```

- [ ] Signup creates user + first business in one transaction; sets `verified_at = now()` when `AUTH_SKIP_VERIFICATION=true`, otherwise issues a `verify` OTP
- [ ] Access JWT 15m (`sub`, `role`); refresh token rotating, httpOnly + secure + SameSite=Lax, 30d, revoked on PIN change
- [ ] Postgres-backed throttle store: per-identifier and per-IP; progressive backoff at 5 failures, lockout at 10
- [ ] Login and reset return constant-time, identical responses for unknown identifier vs wrong PIN
- [ ] **Test first (e2e):** signup→login→refresh→logout; wrong PIN five times triggers backoff; unknown identifier is indistinguishable from wrong PIN
- [ ] Commit: `feat(auth): signup, login, refresh, PIN reset`

**Produces:** `JwtAuthGuard`, `@CurrentUser()`, `RolesGuard`.

---

## Task 6: Tenant isolation layer + adversarial suite

**Files:** Create `apps/api/src/common/scoped.repository.ts`, `apps/api/test/isolation.e2e-spec.ts`

- [ ] `ScopedRepository` exposes only methods that take a resolved `businessId` obtained from `assertOwnsBusiness(userId, businessId)`. No method accepts a raw client-supplied id.
- [ ] All service methods run inside `withTenant(userId, ...)` so RLS sees `app.current_user_id`
- [ ] **Adversarial suite (merge gate):** tenant A attempts read/create/update/delete on tenant B's business, category, item, variant, photo, and storage path. Every attempt must 403 or 404 — never 200.
- [ ] Commit: `feat(security): scoped repository and cross-tenant test suite`

---

## Task 7: Businesses + media

**Files:** Create `apps/api/src/businesses/*`, `apps/api/src/media/*`

```
GET   /businesses/mine
PATCH /businesses/:id        name, type, address*, theme_layout, theme_accent, theme_font, vanity_slug
POST  /businesses/:id/logo/upload-url   -> { uploadUrl, path }
POST  /media/upload-url      { businessId, itemId } -> { uploadUrl, path }
```

- [ ] `generatePublicCode()` — 8 chars, Crockford base32, collision-retried, immutable after creation
- [ ] Signed Supabase Storage upload URLs, 5-minute TTL, path forced to `{businessId}/...` server-side
- [ ] `vanity_slug` validated, unique, reserved-word blocked; `/m/:slug` 301s to `/m/:public_code`
- [ ] **Test:** `PATCH` cannot alter `public_code` or `owner_id`
- [ ] Commit: `feat(businesses): profile, theme, signed uploads`

---

## Task 8: Menu CRUD

**Files:** Create `apps/api/src/menu/categories.controller.ts`, `items.controller.ts`, `menu.repository.ts`

```
POST/PATCH/DELETE /businesses/:bid/categories[/:id]
PATCH             /businesses/:bid/categories/reorder   { ids: string[] }
POST/PATCH/DELETE /businesses/:bid/items[/:id]
PATCH             /businesses/:bid/items/reorder        { categoryId, ids: string[] }
PUT               /businesses/:bid/items/:id/variants   { variants: [...] }   // full replace
PUT               /businesses/:bid/items/:id/photos     { photos: [...] }     // full replace
```

- [ ] Zod DTOs shared from `packages/shared`; item requires `name` and (`price` or ≥1 variant), mirroring the DB trigger
- [ ] Reorder writes `position` in one transaction
- [ ] Every mutation fires `revalidatePublicMenu(publicCode)` after commit
- [ ] **Test first:** creating an item with neither price nor variants is rejected at API *and* DB level; adding variants clears `price`
- [ ] Commit: `feat(menu): categories, items, variants, photos`

---

## Task 9: Public menu + revalidation

**Files:** Create `apps/api/src/public/public.controller.ts`, `public.service.ts`, `revalidate.client.ts`, `apps/web/app/api/revalidate/route.ts`

```
GET  /public/menus/:code   -> PublicMenu (calls get_public_menu, single query)
POST /public/menus/:code/view   -> increments MenuView for today
```

- [ ] `revalidate.client.ts` POSTs `{ path: '/m/<code>' }` with a shared secret to the Next route, which calls `revalidatePath`
- [ ] `PublicMenu` type exported from `packages/shared` — the contract the three templates render
- [ ] **Test:** unavailable items and hidden categories are absent from the payload; unknown code 404s
- [ ] Commit: `feat(public): menu payload and on-demand revalidation`

**Produces:** `PublicMenu` type.

---

## Task 10: QR card generation

**Files:** Create `apps/api/src/qr/qr.service.ts`, `card.svg.ts`, `qr.controller.ts`

```
GET /businesses/:id/qr?format=png|pdf|svg  -> file stream
```

- [ ] `buildCardSvg({ businessName, logoDataUri, url })` — logo, name, QR at EC level H, "Scan for menu", `menu.irad.solutions` at ~45% opacity at the foot
- [ ] PNG via `@resvg/resvg-js` at 300 DPI; PDF via `pdfkit` with the SVG vector-embedded
- [ ] **Test:** generated PNG decodes back to the exact public URL via `jsqr`; watermark string present in SVG output
- [ ] Commit: `feat(qr): watermarked card in SVG, PNG, PDF`

---

## Task 11: Web foundation

**Files:** Create `apps/web/lib/api-client.ts`, `session.ts`, `country.ts`, `app/globals.css`, `packages/shared/theme-tokens.ts`

- [ ] Design tokens: light-first palette, single accent, type scale, 8pt spacing, `prefers-reduced-motion` media query resetting all transitions
- [ ] `api-client.ts` — typed fetch wrapper, attaches access token, transparently refreshes on 401 once
- [ ] `country.ts` — reads `x-vercel-ip-country` server-side, falls back to `Intl.DateTimeFormat().resolvedOptions().timeZone`, defaults `IN`
- [ ] Commit: `feat(web): design tokens, API client, country detection`

---

## Task 12: Auth pages

**Files:** Create `apps/web/app/(auth)/signup|login|forgot-pin/page.tsx`, `components/pin-input.tsx`, `components/identifier-field.tsx`

- [ ] `PinInput` — six single-digit boxes, numeric keypad on mobile, paste-aware, 44px targets
- [ ] `IdentifierField` — one input that switches to a country-code picker the moment the value looks like a phone number, preselected from detected country
- [ ] Signup collects identifier, PIN, name, business name and type; redirects to dashboard
- [ ] Forgot PIN: request OTP → enter code → set new PIN
- [ ] Commit: `feat(web): signup, login, PIN recovery`

---

## Task 13: Dashboard shell, settings, metrics

**Files:** Create `apps/web/app/(app)/layout.tsx`, `dashboard/page.tsx`, `settings/page.tsx`

- [ ] Sidebar: Dashboard, Menu, Templates, QR, Settings. Business switcher rendered only when the owner has more than one business.
- [ ] Dashboard tiles: menu completeness (items missing photos or prices), public link with copy action, QR download, 7/30-day view counts. Layout leaves room for the Phase 2 order and sales tiles.
- [ ] Settings: business name, type, address, logo upload, vanity slug
- [ ] Commit: `feat(web): dashboard and settings`

---

## Task 14: Menu builder

**Files:** Create `apps/web/app/(app)/menu/page.tsx`, `components/menu-builder/*`

- [ ] Collapsible category sections, `dnd-kit` reorder with keyboard fallback
- [ ] `ItemSheet` shows **name, price, photos** only; everything else behind an `AdvancedDetails` disclosure
- [ ] `VariantEditor` — "Add sizes" on the price row; adding a variant replaces the single price input
- [ ] `PhotoUploader` — multi-select, client-side resize to 1600px WebP via canvas, signed upload, drag reorder, first is primary
- [ ] Autosave on blur, optimistic UI, quiet "Saved" indicator, transitions ≤300ms
- [ ] Commit: `feat(web): menu builder`

---

## Task 15: Templates and public menu

**Files:** Create `apps/web/app/(public)/m/[code]/page.tsx`, `components/templates/{editorial,compact,grid}.tsx`, `theme.ts`

- [ ] All three layouts consume the same `PublicMenu` type; theme tokens applied as CSS custom properties on a wrapper
- [ ] Editorial: large photography, one item per row. Compact: dense two-line rows, images off, sticky category rail. Grid: two-across photo cards.
- [ ] Client-side search and veg-only filter over the loaded payload
- [ ] `export const revalidate = false` + on-demand `revalidatePath`; fires the view-count beacon
- [ ] Template picker page with live preview of layout, accent, and font pairing
- [ ] Commit: `feat(web): three templates and public menu`

---

## Task 16: End-to-end verification

**Files:** Create `apps/web/e2e/happy-path.spec.ts`

- [ ] Playwright: signup → business profile → category → item with two variants and two photos → pick Compact template → open `/m/<code>` and assert the item, both variant prices, and photo render → download QR and assert a non-empty PNG
- [ ] Run the full suite: Vitest, Jest e2e, isolation suite, Playwright
- [ ] Commit: `test: end-to-end happy path`

---

## Self-Review

**Spec coverage.** §2 architecture → Tasks 1, 9, 11. §3 isolation → Tasks 2, 6. §4 auth → Tasks 3, 4, 5. §5 data model → Task 2. §6 menu builder → Tasks 8, 14. §7 templates → Task 15. §8 QR → Task 10. §9 dashboard → Task 13. §10 testing → Tasks 6, 16 plus per-task tests. §11 seams → no Phase 1 work by design; `google_place_id`, `MenuView`, and the snapshot-at-order-time note are carried in Task 2's schema.

**Type consistency.** `PublicMenu` is defined in Task 9 and consumed in Task 15. `NotificationChannel`, `Dispatcher`, `OtpService` defined in Task 4, consumed in Task 5. `parseIdentifier`/`hashPin`/`verifyPin` defined in Task 3, consumed in Tasks 5 and 12. `withTenant` defined in Task 2, consumed in Task 6 onward. `generatePublicCode` defined in Task 7, consumed in Tasks 9 and 10.

**Known gap, accepted:** verification is bypassed via `AUTH_SKIP_VERIFICATION` because credentials are unavailable today. The OTP code path is still built and tested against the console driver, so switching it on is an env change, not a code change.
