# Sales records, bill export, and Insights — design

Date: 2026-10-03
Status: approved in conversation, awaiting written-spec review

## Why

Cafes and restaurants need to tally their sales and file income tax returns
(often with an accountant, often under presumptive taxation where cash and
digital receipts are taxed differently). Bills are already stored permanently
and never deleted, but the owner can only see the latest 50, cannot filter
them, cannot download them in bulk, and has no view of how the business is
doing. Payment mode is not recorded at all.

## Goals

1. Record **how each bill was paid**, at a new `paid` order status.
2. A **Sales** page: filter bills by period and attributes, see totals for
   the filter, open a bill, mark it paid or correct its mode.
3. **Export** a period as one ZIP: A5 bill PDFs plus CSVs an accountant can
   tally or import into Excel/Tally.
4. An **Insights** page: sales analytics under the same filters.

## Non-goals

- Voiding or editing bill amounts. Bills stay written-once.
- GST tax-invoice compliance (HSN, CGST/SGST split, FY invoice series). The
  bill remains a receipt that shows tax; the export says so.
- Scheduled/emailed reports, Tally XML.
- A business timezone setting (derived from country, see below).
- Any change to `generate_bill`, the bill/receipt PDFs, `OPEN_STATUSES`, or the
  one-open-order-per-table index.

## Constraints that shaped this

- **The API runs on Vercel serverless**: `maxDuration: 30` and a ~4.5 MB
  response body. A single request cannot render a year of PDFs or return a
  year's CSV. Hence: the browser assembles the ZIP from small batches.
- **Tenant isolation**: every new route is on the owner surface
  (`businesses/:bid/...`), goes through `assertOwns`, and queries through
  `prisma.db` so RLS applies. No new cross-tenant reach.
- **Order day is computed in UTC today** (`CURRENT_DATE`). Reports must not
  inherit that: they bucket on `issued_at AT TIME ZONE <tz>`.

## 1. The `paid` status and payment mode

### Flow

```
placed → accepted → preparing → ready → completed (Served) → paid
```

- **Served is unchanged**: sets `completed`, generates the bill; the diner's
  30-minute bill window still starts at bill issue.
- **Paid** is terminal. Marking paid requires a payment mode. In one
  transaction it: generates the bill if absent (idempotent), sets
  `bills.payment_mode` and `bills.paid_at`, sets the order to `paid`, and sets
  `completed_at` if it was null. The existing status trigger logs a `paid`
  event in `order_events`.
- **Forward skip**: any open status and `completed` may go to `paid`, so a
  pay-at-counter cafe can mark paid without serving first.
- **Correction**: the owner may change the mode on an already-paid bill.
  Logged as an `order_events` row `kind: 'payment_mode_changed'`,
  `data: { from, to }`. A mode cannot be set on an unpaid bill except by
  marking it paid.
- **Paid is not reversible.**

### Schema (additive)

Migration A (alone, because a new enum value cannot be used in the same
transaction that adds it — same pattern as `accepted`):

```sql
ALTER TYPE "OrderStatus" ADD VALUE 'paid' AFTER 'completed';
```

Migration B:

```sql
CREATE TYPE "PaymentMode" AS ENUM ('cash', 'upi', 'card', 'other');
ALTER TABLE bills
  ADD COLUMN payment_mode "PaymentMode" NULL,
  ADD COLUMN paid_at      timestamptz(6) NULL,
  ADD CONSTRAINT bills_paid_consistent
    CHECK ((payment_mode IS NULL) = (paid_at IS NULL));
CREATE INDEX bills_business_id_paid_issued_idx
  ON bills (business_id, payment_mode, issued_at);
```

plus redefinitions of every SQL function that treats `'completed'` as the
finished state, so `paid` behaves identically:

| Function | Change |
|---|---|
| `place_table_round` (latest: `20260928000000_order_round_fixes`) | running-order lookup `status = 'completed'` → `status IN ('completed','paid')` |
| `get_table_order` (latest: `20260928000000_order_round_fixes`) | closed check `IN ('completed','cancelled')` → add `'paid'` |
| `get_ratable_order` | `o.status = 'completed'` → `IN ('completed','paid')` |
| `remove_service_charge` | refuse when the bill has `paid_at` set — a paid amount must not change after the fact |

Each redefinition copies the latest existing body verbatim and changes only
the predicate. The one-time backfill in `order_events` needs no change.

`menu_app` already has DML on `bills`; RLS policy `bills_owner` covers the
new columns. No policy change.

### Code

- `transitions.ts`: add `paid` to `ORDER_STATUSES`; `ALLOWED_TRANSITIONS`
  gains `paid` from `placed, accepted, preparing, ready, completed`;
  `paid: []`. `OPEN_STATUSES` unchanged.
- `setStatus` refuses `paid` (it needs a mode); a dedicated route does it.
- Shared: `PAYMENT_MODES`, labels, `markPaidSchema`.
- Diner side (`ordering.tsx`, `order-timeline.ts`): `paid` label
  ("Paid — thank you"); the timeline FLOW ends at `paid`.

### Board (`/orders`)

- New **To collect** column after Ready: `completed` orders not yet paid,
  each with **Paid**.
- **Paid** opens a sheet: bill total and four large buttons (Cash, UPI, Card,
  Other). Nothing is written until one is chosen.
- Open orders get **Paid** in their overflow actions (counter service).
- History shows `paid` and `cancelled`; pre-existing `completed` orders also
  remain in history and can be marked paid there or from Sales.

## 2. Local time and periods

- Timezone from `businesses.country` via a map in `@menu/shared`
  (`IN → Asia/Kolkata`; unknown → `UTC`).
- `from`/`to` are local dates, `to` inclusive. Converted in SQL:
  `issued_at >= (from::timestamp AT TIME ZONE tz)` and
  `< ((to + 1)::timestamp AT TIME ZONE tz)`.
- Financial year: 1 April – 31 March.
- Presets: Today, Yesterday, This week (Mon start), This month, Last month,
  This FY, Last FY, Custom. Maximum span 400 days.

## 3. Shared filter

One Zod schema in `@menu/shared` (`salesFilterSchema`), parsed from query
strings by both controllers and serialised to/from the page URL by the web.

| Param | Meaning |
|---|---|
| `from`, `to` | required, `YYYY-MM-DD` |
| `modes` | comma list of `cash,upi,card,other,unpaid` |
| `tables` | comma list of table labels (matches `bills.table_label` snapshot) |
| `categoryId` / `menuItemId` | bills containing a line whose order item maps to that item/category |
| `minTotal`, `maxTotal` | on `bills.total` |
| `billNo` | exact `bill_number` |

Category/item path: `bills.order_id → order_items.menu_item_id →
menu_items.category_id`. This is the item's **current** category; deleted
items (`menu_item_id` null) appear as "Deleted item" and match no category
filter. `generate_bill` is not changed to snapshot categories.

A single builder (`sales-filter.sql.ts`) turns the parsed filter into a
`Prisma.sql` WHERE fragment, shared by list, export and analytics so the
three can never disagree about which bills a filter means.

## 4. API

New `SalesController` and `AnalyticsController` (`apps/api/src/sales/`),
registered in `AppModule`. All owner-authenticated; every handler calls
`assertOwns` first.

1. `GET businesses/:bid/bills?<filter>&cursor=&limit=50`
   Replaces the existing unfiltered `GET bills` (same path, same per-bill
   shape plus `paymentMode`, `paidAt`, `orderId`). Cursor on
   `(issued_at, id)` descending. Response:
   `{ bills, nextCursor, totals: { count, gross, tax, serviceCharge, roundOff,
   net, byMode: { cash, upi, card, other, unpaid } } }` — totals cover the
   whole filter, not the page. No web code calls the old route, so `from`/`to`
   are simply required.
2. `POST businesses/:bid/orders/:id/paid` body `{ mode }` — the mark-paid
   transaction above. Returns the order and bill.
3. `PATCH businesses/:bid/bills/:billId/payment-mode` body `{ mode }` —
   correction on a paid bill only (409 otherwise).
4. `GET businesses/:bid/bills/export/rows?<filter>&cursor=` — up to 1000 bills
   per page with lines and line categories, as JSON. The browser builds CSVs.
5. `POST businesses/:bid/bills/export/pdfs` body `{ billIds }` (1–25) — returns
   `application/zip` (fflate, store-only) of `bill-<number>.pdf`. All ids must
   belong to `:bid`, else 404 for the whole request. Logo fetched once.
6. `GET businesses/:bid/analytics?<filter>` — one payload:
   - `kpis`: gross, net, tax, serviceCharge, bills, avgBill, itemsSold,
     paidByMode, unpaid; each with `previous` for the equal-length preceding
     period
   - `series`: `{ bucket: 'day'|'week'|'month', points: [{ start, gross,
     bills }] }` (day ≤ 62 days, week ≤ 190, else month)
   - `paymentMix`
   - `topItems` (name+variant, category, qty, gross) top 20; `topCategories`
   - `heatmap`: 7×24 bills and gross by local weekday/hour
   - `tables`: label, bills, gross
   - `kitchen`: median minutes placed→accepted, accepted→ready,
     ready→completed, completed→paid (from `order_events`, orders in period)
   - `cancellations`: units, value, by reason (from
     `order_item_cancellations.created_at` in period; table/category filters
     apply where meaningful, payment/total filters do not)
   - `ratings`: average, count, distribution 1–5

   Item-level sections use `bill_lines`. Queries are aggregate `$queryRaw` on
   `prisma.db` (inside the tenant transaction).

Revenue in analytics counts **all billed sales** (paid and unpaid) — income
is recognised when billed — with unpaid shown separately.

## 5. Export ZIP (browser-assembled)

`sales_<business-slug>_<from>_to_<to>.zip`:

```
bills/bill-000123.pdf …
sales-register.csv
bill-items.csv
daily-summary.csv
README.txt
```

- `sales-register.csv`: Bill No, Date, Time, Table, Status, Payment Mode,
  Paid At, Items, Subtotal, Tax, Service Charge, Round Off, Total, Prices
  Include Tax, Tax Label, GSTIN
- `bill-items.csv`: Bill No, Date, Item, Variant, Category, Qty, Unit Price,
  Line Total, Net, Tax Rate %, Tax Amount
- `daily-summary.csv`: Date, Bills, Gross, Net, Tax, Service Charge, Round
  Off, Cash, UPI, Card, Other, Unpaid; final row = period total
- `README.txt`: business, period, timezone, filters applied, generated at,
  and "These are receipts showing tax, not GST tax invoices."

CSV: UTF-8 with BOM, RFC 4180 quoting, ISO dates, local times, numbers as
plain 2-decimal strings without currency symbols.

Flow: page through `export/rows` → build CSVs → request PDFs in batches of 25
(concurrency 2) → unzip each batch's entries into the final archive with
`fflate` → download as a Blob. Progress "Preparing bills 340 / 1,200",
Cancel button. A batch is retried twice; after that the export aborts with
an error — never a partial ZIP. "CSV only" skips PDFs. Above 3000 bills the
dialog warns it takes several minutes and the tab must stay open.

## 6. UI

- **Nav**: Sales and Insights after Orders. Billing (settings) unchanged.
- **Overview**: one "Today" card (gross, bills, unpaid) linking to Insights.
- **Filter bar** (`components/sales/filter-bar.tsx`): preset Segmented,
  "More filters" (bottom `Sheet` on narrow screens), removable chips, Clear
  all. State lives in the URL query.
- **`/sales`**: totals strip (Unpaid highlighted when non-zero); bill list
  50 at a time with Load more (table on desktop, cards on mobile); bill detail
  sheet with lines, Download bill/receipt, Mark paid or Change mode; Export
  dialog.
- **`/insights`**: KPI tiles with ▲/▼ vs previous period; sales over time
  bars; payment mix stacked bar; top items table (qty/revenue sort, category
  toggle); weekday×hour heatmap; tables bars; kitchen-time medians;
  cancellations; ratings distribution.
- Charts are dependency-free SVG components in `components/insights/`, using
  theme tokens (light/dark), with tooltips and empty states.

## 7. Testing

- API vitest: transitions incl. `paid`; filter → SQL fragment; local-date →
  UTC range and FY presets; CSV formatting (shared helper).
- SQL behaviour spec for the migration: a `paid` order counts as finished for
  running orders, `get_table_order`, rating; service charge cannot be removed
  from a paid bill.
- `check-isolation.sh`: tenant B, a table session, and the platform admin
  are each refused on sales list, export rows, export pdfs (with A's bill
  ids), mark paid, payment-mode change, and analytics.
- Web vitest: filter ↔ URL round trip; CSV builders; ZIP assembly with a
  fake batch fetcher (incl. retry/abort).
- Playwright: serve → paid (UPI) → appears on Sales with UPI → CSV-only
  export contains the bill row → Insights shows the sale.

## 8. Housekeeping

- Update `CLAUDE.md` (stale after the recent pull: Vercel serverless,
  `DIRECT_URL`, OTP channels move, web/shared vitest) and add the `paid`
  status to the list of hand-maintained SQL status predicates.
