# Menu Platform — Phase 2 Design (Table Ordering)

**Date:** 2026-08-30
**Status:** Approved for planning
**Builds on:** `2026-08-30-menu-platform-phase1-design.md`

---

## 1. Scope

Diners at a table scan a table-specific QR, browse the menu, and place orders.
Staff see those orders on a live board and move them through to completion.

**In scope:** tables and their QR cards, table-bound sessions, the diner ordering
surface, a running tab per table, the staff order board, order status.

**Out of scope, deferred to Phase 3:** bills, GST and tax configuration, the
30-minute customer bill download, post-order Google reviews. Phase 4 keeps the
merchandise storefront.

### Success criteria

1. Scanning a table card puts a diner into an ordering session in one hop, with
   no table identifier visible in the address bar.
2. Editing the URL cannot reveal or modify another table's order.
3. A diner who opens the ordering page with no session is offered the scanner
   rather than an error.
4. Two phones at the same table see the same running order.
5. An order placed by a diner appears on the staff board within five seconds.
6. A menu price change never alters an order already placed.

---

## 2. The table-binding problem

The brief states the requirement and the constraint together: a diner must be
able to order from their table, but the table's URL must not differ, "otherwise
user will be able to see other table order by changing the url."

These look contradictory — a QR on table 5 must encode something distinct from
table 6 — and the resolution is to separate the two roles that URL was playing.

**The table card encodes a claim, not an address.** Each table has a long random
token, printed only on its own card:

```
https://menu.irad.solutions/t/9c4f2a7be1d84c05
```

Hitting it does one thing and then stops existing as a location: the server
resolves the token, sets a **signed, httpOnly session cookie** naming the table,
and redirects to `/order`.

**`/order` is the same address for every table, at every business.** There is no
table in the path, no query string, nothing to edit. A diner who tries
`/order?table=6` changes nothing, because the table is read from a cookie they
cannot read or forge. Session state lives where the brief asked for it.

**No cookie means no table**, which is precisely when the scanner opens — the
requirement that if the state does not exist, the scanner opens automatically.

### Why the cookie is set by the web app, not the API

The session cookie is minted by the API (it holds the signing key) but **set by
Next**, on Next's own origin, and never handed to client JavaScript. Diner-facing
API calls are proxied through Next route handlers that read the httpOnly cookie
server-side and attach it as a bearer token.

The alternative — giving the browser the token to send itself — would mean the
session sits in JavaScript's reach, where any script on the page can lift it and
replay it against another table. Proxying costs a thin handler per endpoint and
removes that entire class of problem.

### Threat notes

- The token is 32 hex characters from a CSPRNG. Guessing one is not a practical
  attack; possessing one means possessing the physical card, which is the same
  trust level as sitting at the table.
- Sessions expire after 12 hours, so a diner who scanned at lunch is not still
  bound to that table at dinner.
- The cookie is signed. A forged or tampered cookie fails verification and is
  treated as absent, which drops the diner to the scanner.
- Sharing a table link with a friend binds them to that table. That is correct
  behaviour, not a leak: they could have scanned the card.

---

## 3. Data model

```sql
tables
  id           uuid pk
  business_id  uuid fk
  label        text            -- "12", "Balcony 3", "Screen 2 Row F"
  token        text unique     -- 32 hex chars, printed on the card, immutable
  position     int
  is_active    bool default true

orders
  id            uuid pk
  business_id   uuid fk
  table_id      uuid fk
  status        OrderStatus     -- placed | preparing | ready | completed | cancelled
  business_day  date            -- for the daily number and for reporting
  daily_number  int             -- per business per day; what staff call out
  placed_at     timestamptz
  completed_at  timestamptz null
  note          text null

  UNIQUE (business_id, business_day, daily_number)
  -- At most one open order per table. A partial unique index rather than
  -- application logic, because two phones at one table WILL race.
  UNIQUE (table_id) WHERE status IN ('placed','preparing','ready')

order_items
  id             uuid pk
  order_id       uuid fk
  business_id    uuid fk
  menu_item_id   uuid null       -- kept for reporting; nulled if the dish is deleted
  name_snapshot  text not null
  variant_snapshot text null
  unit_price     numeric(10,2) not null
  quantity       int not null
  batch          int not null    -- which round this arrived in
  created_at     timestamptz
```

### Snapshotting

`order_items` stores the dish name, variant name, and unit price **as they were
when ordered**. It does not join live menu rows.

This is the difference between a bill that is right and a bill that is a
liability. If a cafe raises the price of a latte at 3pm, a table that ordered at
2pm must still be charged what the menu said at 2pm. Joining live rows would
silently rewrite history, and the error would only surface as a customer dispute.
`menu_item_id` is retained for sales reporting but is nullable and never
authoritative for price.

### The running tab

A table has at most one open order, enforced by a partial unique index. Placing a
round when an open order exists appends items with the next `batch` number rather
than creating a second order. Staff see batches so they know what is new.

`completed` and `cancelled` fall outside the partial index, which is what frees
the table for its next diners. This is also how "show only current order, not
previous" holds: the diner's view queries the table's *open* order, so completion
resets the table to empty.

---

## 4. Diner surface

`/order`, one address for everyone.

- **No valid session** → the scanner. Camera via `BarcodeDetector` where
  available, with a typed-code fallback for browsers and devices without it.
- **Valid session** → the business's menu in their chosen template, with each
  dish gaining a quantity stepper.
- **Cart** is client-side only, kept in `localStorage` keyed by table so a
  dropped connection or a locked phone does not lose a half-built order. Nothing
  reaches the server until the diner places the round.
- **Placing** sends the batch; the cart clears; the current order and its status
  appear.
- **Current order** shows the running tab with a live status, and only ever the
  open one.

Ordering is anonymous. No name, no phone, no login — the table is the identity,
which is what the brief specified and what a diner actually wants at a table.

---

## 5. Staff surface

`/orders` in the dashboard.

A board grouped by status, newest first, polled every five seconds. Each card
shows the table label, the daily number, elapsed time since placing, and items
grouped by batch so a new round is visibly new.

Status moves forward with one tap: Placed → Preparing → Ready → Completed, with
Cancel available throughout. No accept step, per the decision to send orders
straight to the kitchen.

Polling rather than websockets: five seconds is well inside what a kitchen needs,
it survives flaky restaurant wifi without reconnection logic, and it adds no
infrastructure. Revisit if a business runs enough concurrent tables to make it
expensive.

### Table management

`/tables` in the dashboard: add, rename, reorder, deactivate. Each table's QR
card downloads in the same PNG/PDF/SVG formats as the venue card, carrying the
table label alongside the business name so staff can tell them apart in a stack
of printed cards.

---

## 6. Endpoints

**Public, token-bound (proxied through Next, never called directly by the
browser):**

```
POST /public/tables/resolve   { token }  -> { sessionToken, table, business }
GET  /public/table/session               -> { table, business }
GET  /public/table/menu                  -> PublicMenu
GET  /public/table/order                 -> current open order or null
POST /public/table/order                 { items: [{ itemId, variantId, quantity }] }
```

The last four authenticate with the table session token, not a user JWT.

**Owner:**

```
GET    /businesses/:bid/tables
POST   /businesses/:bid/tables            { label }
PATCH  /businesses/:bid/tables/:id        { label, isActive }
DELETE /businesses/:bid/tables/:id
GET    /businesses/:bid/tables/:id/qr?format=png|pdf|svg
GET    /businesses/:bid/orders?scope=open|today
PATCH  /businesses/:bid/orders/:id/status { status }
```

---

## 7. Isolation

`tables`, `orders`, and `order_items` all carry `business_id` and come under the
same RLS policies as Phase 1's tables, with the same reasoning.

Table-session endpoints are a **second, narrower principal**: a session token
grants access to exactly one table's open order at one business, and nothing
else. It can read the menu and write to its own order. It cannot read another
table, cannot read a completed order, and cannot touch anything under
`/businesses`.

The Phase 1 adversarial suite gains cases for it: a session bound to table A
attempting to read or write table B's order, and a session attempting any owner
endpoint. Both must fail, and the check stays a merge gate.

---

## 8. Testing

| Layer | Covers |
|-------|--------|
| Unit | Batch numbering, daily-number allocation, snapshot correctness |
| API e2e | Resolve → place → append → status transitions; one-open-order-per-table under concurrent placement |
| Isolation | Table A's session against table B; table session against owner routes |
| Browser | Scan → order → second round appends → staff advances status → diner sees it |

The concurrency case is explicit: two simultaneous placements at one table must
produce one order with two batches, never two orders.

---

## 9. Decisions log

| Decision | Chosen | Rejected |
|----------|--------|----------|
| Table binding | Token URL redirects to a shared `/order`, signed httpOnly cookie | Table in the path or query |
| Session custody | Minted by API, set and held by Next, proxied | Token handed to client JS |
| Rounds | Running tab, batches append to one open order | One order then locked |
| Acceptance | Straight to the kitchen | Staff accept first |
| One-open-order | Partial unique index | Application-level check |
| Pricing | Snapshot at order time | Join live menu rows |
| Live updates | 5s polling | Websockets/SSE |
| Diner identity | Anonymous, table is the identity | Name or phone required |
