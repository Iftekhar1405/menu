# Menu Platform — Phase 1 Design (Owner Core)

**Date:** 2026-08-30
**Status:** Approved for planning
**Product:** menu.irad.solutions — multi-tenant digital menu and QR ordering platform for restaurants, cafes, and movie theatres

---

## 1. Scope

The product as a whole comprises six subsystems. This spec covers **Phase 1 only**.

| # | Subsystem | Phase |
|---|-----------|-------|
| 1 | Auth and tenancy | **1** |
| 2 | Business profile and menu builder | **1** |
| 3 | Templates and public menu | **1** |
| 4 | Table-bound ordering | 2 |
| 5 | Billing, order ops, post-order reviews | 3 |
| 6 | QR merchandise (PVC/epoxy) storefront | 4 |

Phase 1 delivers the smallest genuinely useful product: **an owner can sign up, describe their business, build a menu, choose a template, and download a print-ready QR code that diners can scan to view that menu.**

Phases 2–4 are out of scope here. They are referenced only where Phase 1 must leave a seam for them (§11).

### Success criteria

1. A new owner completes signup → business profile → first menu item in under five minutes.
2. A diner scanning the QR sees a fully rendered menu in under two seconds on a 3G connection.
3. An owner's menu edit is visible on the public URL within ten seconds.
4. No authenticated request can read or write another tenant's data, proven by an adversarial test suite.
5. A downloaded QR card prints legibly at 300 DPI and scans reliably from 1.5 metres.

---

## 2. Architecture

Three deployables.

```
Browser
  ├─ Next.js 15 (Vercel) ──── HTTPS/JSON ───▶ NestJS API (Railway/Render/Fly)
  │    owner dashboard                            │
  │    public menu (ISR)                          ├──▶ Supabase Postgres (Prisma)
  │                                               ├──▶ Supabase Storage (signed URLs)
  │                                               ├──▶ Meta WhatsApp Cloud API
  └──── direct upload (signed URL) ──────────────▶ Supabase Storage
                                                  └──▶ Resend (email)
```

**Next.js 15, App Router, TypeScript, Tailwind — deployed on Vercel.**
Two route groups: `(app)` for the authenticated owner dashboard, `(public)` for the diner-facing menu at `/m/[code]`. The frontend never touches the database. All reads and writes go through the Nest API.

**NestJS, TypeScript, Prisma.**
The entire backend. Phase 1 modules: `auth`, `users`, `businesses`, `menu`, `media`, `qr`, `notifications`. Later phases add `tables`, `orders`, `billing`, `reviews`, `merch` as new modules rather than rewrites of these.

**Supabase — Postgres and Storage only.**
Supabase Auth is not used; Nest owns identity (§4). Prisma is the only database client.

### Rendering strategy for the public menu

The public menu is statically rendered with ISR. Next fetches `GET /public/menus/:code` at build and revalidation time. When an owner saves a change, Nest calls a Next revalidation webhook for that one path.

This is a deliberate choice, not a default. Menus are scanned on congested restaurant wifi and cellular data. Serving edge-cached HTML rather than a database round trip per scan is the single largest lever on perceived quality of the product.

### Media upload path

Photo bytes never transit the Nest API. The browser requests a short-lived signed upload URL from Nest, uploads directly to Supabase Storage, then posts the resulting object path back to Nest for persistence. Keeps the API stateless and avoids paying for bandwidth twice.

---

## 3. Tenant isolation

This is the highest-severity risk in the system and is defended twice.

In a Supabase-direct architecture, Postgres RLS is the tenant boundary. With Nest holding a privileged connection, **RLS protects nothing by default** — a single forgotten `WHERE businessId` leaks another business's data. Therefore:

**Layer 1 — Application.** All business-scoped queries go through a repository layer where `businessId` is derived from the authenticated JWT and is structurally impossible to omit. `businessId` is never read from a request body, query string, or URL parameter that the client controls. Route params naming a business are validated against the caller's owned businesses before use.

**Layer 2 — Database.** Nest connects as a non-superuser role with RLS enabled on every table. Each request runs inside a transaction that issues `SET LOCAL app.current_user_id = <uuid>`; policies read `current_setting('app.current_user_id')`. If the application layer forgets a filter, the database refuses the row.

**Proof.** A dedicated adversarial test suite authenticates as tenant A and asserts that every read, write, update, and delete targeting tenant B's rows fails — across businesses, categories, items, variants, photos, and storage objects. This suite is a merge gate.

Storage follows the same shape: object paths are `{businessId}/...` and storage policies check the first path segment against the caller's businesses.

---

## 4. Authentication

### Model

Login is **6-digit PIN only**. There are no passwords.

```sql
users
  id             uuid pk
  email          text unique null
  phone          text unique null          -- E.164
  pin_hash       text not null             -- argon2id
  full_name      text not null
  role           text not null default 'owner'   -- 'owner' | 'platform_admin'
  verified_at    timestamptz null
  failed_attempts int not null default 0
  locked_until   timestamptz null
  created_at     timestamptz not null default now()

  CHECK (email IS NOT NULL OR phone IS NOT NULL)
```

An account carries an email, a phone, or both. At least one is required.

### Flows

**Signup.** Identifier (email or phone) + 6-digit PIN + full name + business name. The country dial code is preselected from the Vercel edge geo header `x-vercel-ip-country`, falling back to `Intl.DateTimeFormat().resolvedOptions().timeZone`, defaulting to India, and always overridable via a country picker. `navigator.geolocation` is deliberately not used — it raises a browser permission dialog to learn something an IP header already provides.

**Verification.** An OTP is required before a menu can be published.

**Login.** Single identifier field, sniffed as email or phone, plus the PIN. Returns a 15-minute access JWT and a rotating refresh token in an httpOnly, secure, SameSite=Lax cookie with a 30-day lifetime.

**Forgot PIN / lockout recovery.** OTP to all available channels, then set a new PIN. Refresh tokens for the account are revoked on PIN change.

### OTP: one code, fanned out

A verification request mints **one** 6-digit code and dispatches that same code to **every channel the account has** — WhatsApp and email when both are present.

```sql
otp_challenges
  id            uuid pk
  user_id       uuid fk
  purpose       text not null      -- 'verify' | 'recover'
  code_hash     text not null      -- argon2id
  expires_at    timestamptz not null    -- issued_at + 10 minutes
  attempts      int not null default 0
  consumed_at   timestamptz null
```

- Single-use, 10-minute expiry, maximum 5 verification attempts.
- **Partial delivery failure is tolerated.** If WhatsApp succeeds and email bounces, the flow proceeds. Only an all-channels failure surfaces an error to the user.
- Resend is rate-limited independently of PIN attempts.
- A "didn't get it?" path re-dispatches and, where only one channel exists, surfaces support contact.

### NotificationChannel interface

Both delivery providers sit behind one interface with a console/mock driver used in development and tests, so no external account blocks the build.

- **WhatsApp:** Meta WhatsApp Business Cloud API, direct. Requires a Meta Business account, a verified WhatsApp Business number, and one approved authentication-category template.
- **Email:** Resend. Swappable for SES or Postmark in one file.

### Hardening

- Argon2id for both PIN and OTP hashes.
- Per-account and per-IP throttling backed by a shared store (not in-memory, since the API may run more than one instance).
- Progressive backoff on failed PIN attempts, then lockout with OTP recovery.
- Constant-time responses on login and recovery so the endpoints cannot be used to enumerate accounts.

### Accepted risk

**A 6-digit PIN has one million possible values and is the sole authentication factor.** Argon2id and rate limiting contain online guessing, but a database breach exposes credentials to offline attack quickly. This trade-off was raised during design and accepted deliberately in favour of login speed for restaurant staff. Should the exposure profile change — once billing data and order history accumulate in Phase 3 — the recommended mitigation is trusted-device binding: OTP on first use of a new device, PIN alone thereafter. The `otp_challenges` table and `NotificationChannel` interface already support this without schema change.

---

## 5. Data model

```sql
businesses
  id               uuid pk
  owner_id         uuid fk -> users
  name             text not null
  type             text not null            -- 'restaurant' | 'cafe' | 'theatre'
  logo_path        text null
  address_line1    text null
  address_line2    text null
  city             text null
  state            text null
  postal_code      text null
  country          text not null default 'IN'
  public_code      text unique not null     -- permanent, opaque, never editable
  vanity_slug      text unique null         -- renameable, redirects to public_code
  currency         text not null default 'INR'
  theme_layout     text not null default 'editorial'
  theme_accent     text not null default '#1D6F5C'
  theme_font       text not null default 'inter-fraunces'
  google_place_id  text null                -- Phase 3
  created_at       timestamptz not null default now()

menu_categories
  id, business_id fk, name, position int, is_visible bool default true

menu_items
  id               uuid pk
  business_id      uuid fk                  -- denormalised for isolation queries
  category_id      uuid fk
  name             text not null
  price            numeric(10,2) null
  description      text null
  is_available     bool not null default true
  position         int not null
  -- advanced, all optional
  diet_tag         text null                -- 'veg' | 'non_veg' | 'vegan' | 'egg'
  spice_level      int null                 -- 0-3
  prep_time_mins   int null
  ingredients      text null
  allergens        text[] null
  nutrition        jsonb null               -- { calories, protein_g, carbs_g, fat_g, ... }
  created_at       timestamptz not null default now()

menu_item_variants
  id, item_id fk, name, price numeric(10,2) not null, position int

menu_item_photos
  id, item_id fk, storage_path text not null, position int, alt text null
```

### Three decisions worth recording

**Price is nullable on the item, guarded by a constraint requiring either a base price or at least one variant.** The requirement that price is mandatory holds — it is enforced at whichever level actually carries the price. A latte offered in three sizes has no meaningful single price, and storing a placeholder there produces a wrong bill in Phase 3. Because a cross-table `CHECK` is not expressible in Postgres, this is enforced by a deferred constraint trigger on `menu_items` and `menu_item_variants`, plus DTO validation at the API boundary.

**`owner_id` sits on `businesses`, rather than a `business_id` on the user.** Costs nothing now and means a chain owner with three cafes is a UI change, not a migration. Phase 1 renders a business switcher only when the owner has more than one.

**`business_id` is denormalised onto `menu_items`.** Redundant with the join through `menu_categories`, and deliberately so: it makes every isolation filter and RLS policy a single-column predicate rather than a join, which is exactly the kind of query that gets written wrong under time pressure.

### Public read path

Anonymous users get **no direct table access**. The public menu is served by a single `SECURITY DEFINER` function:

```sql
get_public_menu(p_code text) RETURNS jsonb
```

It returns the whole menu — business identity, theme tokens, visible categories, available items with variants and photos — as one JSON payload for one code. This prevents business enumeration and holds the public render to a single query.

---

## 6. Menu builder

One page, not a wizard.

Categories render as collapsible sections, reorderable by drag. Items drag within and between categories. `dnd-kit` for both, with keyboard-accessible fallbacks.

**The item sheet shows exactly three things: name, price, photos.** Everything else lives behind an **Advanced details** disclosure — description, ingredients, allergens, nutrition, diet tag, spice level, prep time. An owner entering thirty items must never encounter a nutrition field unless they went looking for it.

**Variants.** A small "Add sizes" affordance on the price row. The moment an item has variants, the single price input is replaced by the variant list, so the two can never disagree.

**Photos.** Multi-select upload, drag to reorder, first is primary. Resized client-side to a maximum of 1600px and converted to WebP before the signed upload — cheaper storage and a materially faster public menu on mobile data.

**Saving.** Autosave on blur, optimistic UI, quiet "Saved" indicator. This is a utility surface: nothing animates for longer than 300ms, and no motion carries meaning that the text does not.

---

## 7. Templates and the public menu

### Three layouts, one data shape

| Layout | Character | Suits |
|--------|-----------|-------|
| **Editorial** | Large photography, generous whitespace, one item per row | Places whose food photographs well |
| **Compact** | Dense two-line rows, images off by default, sticky category rail | Cinema concessions, high-volume cafes, scanning while queuing |
| **Grid** | Photo-forward cards, two across on mobile | Visual menus with broad category spread |

### Theming

Three tokens — layout, accent colour, font pairing — applied as CSS custom properties, previewed live while choosing. Constrained enough that every menu on the platform looks good; expressive enough that owners feel it is theirs.

### Design direction

The dashboard is a **utility** surface; the public menu is the **flagship** surface. Both follow the same discipline, drawn from Apple HIG principles:

- Light-first. Dark is a mode, never the default hero.
- One accent colour plus neutrals and whitespace.
- Hierarchy carried by type and space — not by boxes, borders, or glow.
- Translucency reserved for chrome (sticky headers, sheets), never on content cards.
- Minimum 44px touch targets.
- Spring-based motion, interruptible, full `prefers-reduced-motion` support.
- Utility surface: springs ≤300ms, cinematic effects off. Flagship surface: scroll-linked category rail and spring item transitions earn their place.
- Real photography in real proportions. No placeholder blobs, no gradient-text flourishes.

Before shipping any effect: remove it and ask whether the design lost meaning or merely decoration.

### Diner-facing features

Client-side search and a veg-only filter. Long menus are unusable without them, and both operate on the already-loaded payload at zero network cost.

---

## 8. QR generation

Nest composes an SVG card server-side:

- Business logo and name at the top
- QR at error-correction level H (survives logo overlay and print wear)
- A "Scan for menu" instruction line
- `menu.irad.solutions` set small and low-contrast at the foot as a subtle platform watermark

Rendered to a **300 DPI PNG** via resvg and to a **vector PDF**. The same asset serves a table tent today and the PVC/epoxy card sold in Phase 4, which is why vector output is in Phase 1 rather than deferred — print vendors need it and regenerating from raster is not an option.

The QR encodes `https://menu.irad.solutions/m/{public_code}`. Because `public_code` is permanent and opaque, renaming a business or changing its vanity slug never invalidates printed cards.

---

## 9. Owner dashboard

Minimal by design in Phase 1, because the metrics that matter (orders, sales) do not exist until Phase 2.

Phase 1 shows: menu completeness (categories, items, items missing photos or prices), public menu link with copy action, QR download, template picker entry, and total public menu views over the last 7 and 30 days.

View counting is a single counter incremented from the public route, not an analytics pipeline. When Phase 2 lands, this dashboard gains the order and sales tiles it was laid out to accommodate.

---

## 10. Testing

| Layer | Tool | Covers |
|-------|------|--------|
| Unit | Vitest | Price/variant validation, OTP lifecycle, QR composition, theme token resolution |
| API e2e | Jest + Supertest | Auth flows, menu CRUD, signed upload issuance, public menu function |
| **Isolation** | Jest | **Cross-tenant adversarial suite — merge gate** |
| Browser | Playwright | Signup → business → item with variants and photos → public menu renders → QR downloads |

TDD applies throughout. The isolation suite and the Playwright happy path are both merge gates.

---

## 11. Seams left for later phases

Phase 1 makes no attempt to build these, but does not foreclose them.

**Phase 2 — Table ordering.** Adds `tables`, `orders`, `order_items`. Order line items **snapshot item name and price at order time** rather than joining live menu rows, so a menu edit never rewrites history or a bill. Table sessions bind to a cookie/localStorage token rather than a URL parameter, precisely so a diner cannot view another table's order by editing the address bar; absent a valid session token, the page opens the scanner. Only the current order is shown, scoped by table.

**Phase 3 — Billing and reviews.** Adds `tax_config` (GST and related), bill generation, order status transitions. Customer bill download is gated to 30 minutes post-completion by the same session token; owner and platform admin access is permanent.

Post-order review capture, already schema-sketched:

```sql
review_prompts   id, business_id null, rating_band, text, business_type
order_ratings    id, order_id, table_id, stars, prompt_id null,
                 private_feedback text null, created_at
```

A 10-minute window opens on order completion. The diner rates 1–5 stars **in our UI** — a first-party rating that feeds the owner dashboard regardless of what happens next. We then offer predefined review texts matched to rating band and business type, editable inline, with a copy-and-open action pointing at `search.google.com/local/writereview?placeid={google_place_id}`.

**Constraint of record:** no API posts a review to Google on a user's behalf. The Business Profile API only lets an owner *reply*; the Places API only *reads*. Copy-and-deep-link is the only mechanism available.

**Policy of record:** showing the Google path only to 4–5 star raters is review gating, an explicit violation of Google's policies that has cost businesses their review counts. The Google path and the private-feedback path are both offered at every rating level, and low-rating predefined texts are honest ones.

**Phase 4 — Merchandise.** PVC and epoxy QR ordering, visible only to accounts with `role = 'platform_admin'`. Phase 1 ships the role column and a guarded `/admin` route shell; the seeded platform admin account is created by migration.

---

## 12. Decisions log

| Decision | Chosen | Rejected alternative |
|----------|--------|---------------------|
| Phasing | Owner core first | Ordering-first; one monolithic spec |
| Stack | Next.js + NestJS + Supabase Postgres | Next.js + Supabase direct; Express + React SPA |
| Auth owner | Nest owns auth entirely | Supabase Auth with Nest verifying JWTs |
| Credential | 6-digit PIN, no password | Password; PIN + trusted device; PIN for staff only |
| Identifier | Email or phone, at least one | Email always required |
| OTP delivery | One code fanned out to all channels | Single channel with fallback |
| WhatsApp | Meta Cloud API direct | Indian BSP; mock-only |
| Email | Resend | SES, Postmark |
| Public URL | Opaque permanent code + optional vanity slug | Editable slug; subdomain per business |
| Menu depth | Categories + items + variants | Flat items; full modifier system |
| Templates | 3 layouts × theme tokens | 5–6 fixed themes; one deeply customisable layout |
| QR output | Framed card, 300 DPI PNG + vector PDF | PNG only; bare QR |
| Publishing | Save publishes, ISR revalidates | Draft/publish versioning (deferred, additive) |

---

## 13. Out of scope for Phase 1

Ordering, table sessions, billing, GST, order status, bill downloads, post-order reviews, merchandise storefront, staff accounts and roles, multi-language menus, draft/publish versioning, analytics beyond the minimal dashboard described in §9, phone-number-based diner identity.
