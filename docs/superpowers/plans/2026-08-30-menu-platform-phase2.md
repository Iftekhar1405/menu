# Menu Platform Phase 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans or superpowers:subagent-driven-development.

**Goal:** A diner scans their table's card and orders from it; staff work those orders on a live board.

**Spec:** `docs/superpowers/specs/2026-08-30-menu-platform-phase2-ordering-design.md`

**Architecture:** Phase 1's stack unchanged. Two new things: a second authentication principal (a signed table-session token, distinct from the owner JWT), and a Next proxy layer so that token stays httpOnly and never reaches client JavaScript.

## Global Constraints

- `/order` is the same address for every table at every business. No table identifier in any path or query string, ever.
- The table session cookie is httpOnly, signed, 12-hour expiry, set on Next's origin, and never readable by client JS.
- Absent or invalid session → the scanner, never an error page.
- One open order per table, enforced by a **partial unique index**, not application logic. Two phones at a table will race.
- `order_items` snapshot `name`, `variant`, and `unit_price` at order time. Never join live menu rows for price.
- A table session may touch exactly one table's open order at one business, and no `/businesses` route.
- Order statuses: `placed | preparing | ready | completed | cancelled`. No accept step.

---

## Task 1 — Schema

**Files:** `apps/api/prisma/schema.prisma`, new migration

- [ ] `Table`, `Order`, `OrderItem` models; `OrderStatus` enum
- [ ] Raw SQL: partial unique index `orders_one_open_per_table` on `table_id` where status in placed/preparing/ready
- [ ] Raw SQL: unique `(business_id, business_day, daily_number)`
- [ ] RLS enable + FORCE + owner policies on all three, matching Phase 1's shape
- [ ] `next_daily_number(business_id, day)` SECURITY DEFINER helper
- [ ] **Test:** inserting a second open order for one table is rejected by the index

## Task 2 — Table session principal

**Files:** `apps/api/src/tables/table-session.service.ts`, `table-session.guard.ts`

```ts
mint(tableId: string, businessId: string): string   // signed JWT, 12h
verify(token: string): { tableId: string; businessId: string }
```

- [ ] `@TableSession()` param decorator; guard rejects owner JWTs and vice versa
- [ ] **Test:** an owner JWT is refused on table routes; a table token is refused on owner routes

## Task 3 — Tables CRUD + per-table QR

**Files:** `apps/api/src/tables/tables.{controller,service}.ts`, extend `qr.service.ts`

- [ ] `generateTableToken()` — 32 hex chars, CSPRNG, immutable after creation
- [ ] CRUD scoped through `BusinessesService.assertOwns`
- [ ] `buildCardSvg` gains an optional `tableLabel`, rendered under the business name
- [ ] **Test:** the table card's QR decodes to `/t/<token>`

## Task 4 — Ordering endpoints

**Files:** `apps/api/src/orders/orders.{controller,service}.ts`

- [ ] `POST /public/tables/resolve` — token → session + table + business
- [ ] `GET /public/table/{session,menu,order}`
- [ ] `POST /public/table/order` — append a batch, creating the order if none open
- [ ] Prices are re-read server-side from the menu and snapshotted; the client's prices are ignored entirely
- [ ] `GET /businesses/:bid/orders`, `PATCH .../:id/status`
- [ ] **Test:** two concurrent placements yield one order with two batches

## Task 5 — Next proxy + diner surface

**Files:** `apps/web/app/t/[token]/route.ts`, `apps/web/app/api/table/**`, `apps/web/app/order/page.tsx`, `components/order/*`

- [ ] `/t/[token]` — resolve, set cookie, redirect to `/order`
- [ ] Route handlers reading the httpOnly cookie and forwarding as bearer
- [ ] `/order` — scanner when no session; menu + steppers + cart when there is
- [ ] Cart in `localStorage` keyed by table; cleared on successful placement
- [ ] Current order with batches and live status, polled

## Task 6 — Staff board + tables page

**Files:** `apps/web/app/(app)/orders/page.tsx`, `apps/web/app/(app)/tables/page.tsx`

- [ ] Board grouped by status, 5s poll, elapsed time, batch grouping
- [ ] One-tap status advance; cancel available throughout
- [ ] Tables: add, rename, deactivate, download card

## Task 7 — Verification

- [ ] Extend `scripts/check-isolation.sh`: table A's session against table B; table session against owner routes
- [ ] Playwright: scan → order → second round appends → staff advances → diner sees it
- [ ] Full typecheck and build across all three packages
