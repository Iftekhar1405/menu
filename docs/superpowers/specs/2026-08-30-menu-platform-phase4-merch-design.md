# Menu Platform — Phase 4 Design (QR Merchandise)

**Date:** 2026-08-30
**Status:** Approved for planning
**Builds on:** Phases 1–3

---

## 1. Scope

Business owners order printed QR products — PVC table cards, epoxy-domed tags,
acrylic stands — from us. **Only the seeded platform admin can see those orders**,
across every business on the platform, and works them through to delivery.

**Not in scope: payment.** There is no gateway in this system and adding one is
its own integration with its own credentials. An order is a *request*: the owner
submits what they want and where to send it, the admin quotes and fulfils, and
money changes hands outside the product. The owner-facing copy says exactly that
rather than implying a checkout.

---

## 2. The third principal

Phase 1 introduced `role = 'platform_admin'` and a guarded route shell. Phase 4
is the first thing that actually uses it, and it is the first capability in the
system that **deliberately crosses the tenant boundary**: the admin must read
orders belonging to businesses they do not own, and generate QR artwork for
those businesses' tables in order to print it.

That makes the gate worth stating precisely.

Every RLS policy so far has asked one question — does this row belong to a
business owned by the current user. Phase 4 adds a second clause to the merch
tables only:

```sql
app_is_platform_admin()  -- SECURITY DEFINER, reads users.role for the current id
```

It is added to `merch_*` tables and nowhere else. A platform admin still cannot
read another business's menu, orders, bills, or ratings — only the merchandise
requests addressed to us, and the table artwork needed to fulfil one.

**Column-level privacy is handled in the API, not RLS.** `admin_notes` and
internal costing live on the order row, and RLS is row-level: an owner who can
see their order row could see those columns. The API therefore has two shapes
for a merch order — the owner's and the admin's — and the owner's never selects
those fields.

---

## 3. Data model

```sql
merch_products                      -- platform catalogue, no business_id
  id, sku UNIQUE, name, blurb,
  unit_price numeric(10,2), currency,
  min_quantity int, lead_time_days int,
  is_active bool, position int

merch_orders
  id, business_id, order_number int UNIQUE,   -- platform-wide, what we quote against
  status,                                      -- see below
  contact_name, contact_phone, contact_email,
  address_line1, address_line2, city, state, postal_code, country,
  notes text null,            -- from the owner
  admin_notes text null,      -- ours; never returned to an owner
  quoted_total numeric(10,2) null,
  estimated_total numeric(10,2),               -- catalogue maths at request time
  created_at, updated_at

merch_order_items
  id, order_id, product_id, quantity,
  unit_price numeric(10,2),   -- snapshot, same reasoning as everywhere else
  /* Which tables' codes to print. Empty means the venue card (the menu QR)
     rather than a table card. */
  table_ids uuid[]
```

### Status

`requested → quoted → confirmed → in_production → shipped → delivered`, with
`cancelled` reachable from anything not yet delivered. Only the admin moves it.
The owner sees the same statuses, because a customer wondering where their cards
are should see what we see.

### Why `table_ids` and not just a quantity

A PVC card is per-table: each carries a different QR. An order for "20 cards"
without saying *which* tables is unfulfillable, and asking us to guess is how a
restaurant ends up with two cards for table 7 and none for table 12. Selecting
tables also lets the estimate be computed rather than typed.

---

## 4. Surfaces

**Owner** — a section on the existing QR page, plus `/merch`:
catalogue with prices and lead times, table picker, delivery details, submit.
Then a list of their own requests with live status.

**Admin** — `/admin`, gated by `role = 'platform_admin'`:
every request across every business, filterable by status, with the business
name, contact details, item breakdown, and the tables involved. One-tap status
advance, an internal notes field, a quoted total, and — the point of the whole
screen — **a download of the exact artwork to print**: a single PDF containing
one card per selected table.

---

## 5. Seeding

`prisma/seed.ts` creates the platform admin from `SEED_ADMIN_*` and inserts the
product catalogue. It is idempotent — running it twice must not create a second
admin or duplicate products — because it will be run again on every deploy.

*(This script was referenced in Phase 1's package.json but never written; Phase 4
is where it becomes load-bearing.)*

---

## 6. Isolation

The suite gains: an owner reading the admin order list, an owner reading another
business's merch order, an owner reaching admin-only artwork generation, and a
table session touching any of it. It also gains a check that `admin_notes` never
appears in an owner-facing response — the one privacy rule here that RLS cannot
express.

---

## 7. Decisions log

| Decision | Chosen | Rejected |
|----------|--------|----------|
| Payment | Quote and fulfil offline | Razorpay checkout |
| Admin access | Second RLS clause on `merch_*` only | Global admin bypass |
| Internal fields | Withheld in the API layer | RLS (cannot do columns) |
| Order contents | Explicit table selection | Bare quantity |
| Catalogue | Seeded, platform-wide | Per-business pricing |
