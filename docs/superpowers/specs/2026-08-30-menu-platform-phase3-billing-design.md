# Menu Platform — Phase 3 Design (Bills and Reviews)

**Date:** 2026-08-30
**Status:** Approved for planning
**Builds on:** Phase 1 (menu) and Phase 2 (ordering)

---

## 1. Scope

Staff close an order and generate a bill. The diner can download it for 30
minutes; the owner forever. For 10 minutes after completion the diner is invited
to rate their meal, and offered a route to Google.

**Out of scope:** the PVC/epoxy QR storefront (Phase 4), payments, refunds,
credit notes, split bills.

---

## 2. What the bill is, and is not

The bill is an **itemised receipt that shows tax**. It is not a GST tax invoice.

That distinction was chosen deliberately and has a consequence worth stating
plainly: a GST-registered restaurant cannot hand this to a customer as their
tax invoice. It does not carry a financial-year sequential invoice number, HSN
or SAC codes, or a CGST/SGST split, all of which the GST rules require.

What it does carry: business name and address, an optional GSTIN for display, a
per-business sequential bill number, the table, every line with its quantity and
unit price, a tax line computed from real rates, an optional service charge, a
rounding line, and the total.

**Upgrading later is additive.** Because each line snapshots its own tax rate and
tax amount, becoming a compliant tax invoice means adding columns (HSN, a
financial-year sequence, a CGST/SGST split) rather than reinterpreting stored
bills. Nothing here has to be unpicked.

### Immutability

A bill is written once. Regenerating one for an order returns the existing bill
rather than recomputing it, because the whole point of snapshotting is that a
menu price change tomorrow cannot alter a bill printed today. Corrections are a
Phase 4 concern (credit notes); today, a wrong bill is cancelled with the order.

---

## 3. Tax model

```sql
businesses
  + tax_enabled           bool   default false
  + tax_label             text   default 'GST'     -- display only
  + default_tax_rate      numeric(5,2) default 5.00
  + prices_include_tax    bool   default true
  + gstin                 text   null              -- shown if present
  + service_charge_enabled bool  default false
  + service_charge_rate   numeric(5,2) default 0
  + receipt_footer        text   null

menu_items
  + tax_rate              numeric(5,2) null        -- overrides the default
```

### Tax-inclusive pricing

`prices_include_tax` defaults to **true**, because that is how most Indian
restaurants display prices, and because the failure mode of the wrong default is
asymmetric: treating inclusive prices as exclusive overcharges every diner on
every bill, while the reverse merely understates the tax line.

With inclusive pricing the maths runs backwards from the displayed price:

```
line_total  = unit_price × quantity          (what the menu said)
line_net    = line_total ÷ (1 + rate/100)
line_tax    = line_total − line_net
subtotal    = Σ line_net
tax_total   = Σ line_tax
```

With exclusive pricing, `line_net = line_total` and tax is added on top.

Per-item rates exist because packaged goods are taxed differently from prepared
food — a bottle of water on a restaurant bill is not the same rate as a dosa —
and a single business rate would bill one of them wrong.

### Service charge

Off by default, and labelled on the bill as optional with a note that it can be
removed. Since the 2022 CCPA guidelines an automatic or mandatory service charge
is not permitted in India, and restaurants have been ordered to refund it. The
diner-facing bill therefore shows a **Remove** control next to it, which
recomputes the total.

Service charge is calculated on the net subtotal, before tax, and is itself
taxable where tax is enabled.

### Rounding

Totals round to the nearest rupee, with the adjustment shown as its own line so
the arithmetic on the bill always adds up. A bill whose numbers do not reconcile
is worse than one that admits to a 40-paise rounding.

---

## 4. Data model

```sql
bills
  id                uuid pk
  business_id       uuid fk
  order_id          uuid fk UNIQUE      -- one bill per order
  bill_number       int                 -- per business, sequential
  table_label       text                -- snapshot; the table may be renamed
  issued_at         timestamptz
  currency          text

  -- snapshots of the configuration that produced these numbers
  prices_include_tax     bool
  tax_label              text
  service_charge_rate    numeric(5,2)
  business_snapshot      jsonb          -- name, address, gstin, logo path
  receipt_footer         text null

  subtotal          numeric(10,2)       -- net of tax
  tax_total         numeric(10,2)
  service_charge    numeric(10,2)
  round_off         numeric(10,2)
  total             numeric(10,2)

  UNIQUE (business_id, bill_number)

bill_lines
  id            uuid pk
  bill_id       uuid fk
  business_id   uuid fk
  name          text
  variant       text null
  quantity      int
  unit_price    numeric(10,2)
  line_total    numeric(10,2)   -- gross, as displayed
  line_net      numeric(10,2)
  tax_rate      numeric(5,2)
  tax_amount    numeric(10,2)
```

Everything a bill needs to render is snapshotted onto it. Reprinting a bill from
six months ago must not depend on the business still having the same name,
address, tax rate, or menu.

---

## 5. Access windows

| Who | When | How |
|-----|------|-----|
| Diner | 30 minutes after the order completes | Table session, time-boxed |
| Owner | Forever | Owner JWT |
| Platform admin | Forever | Role check |

The diner's route is `GET /public/table/bill`. It returns the most recent bill
for **that session's table**, and only if it was issued within the last 30
minutes. There is no bill id in the request, so there is nothing to enumerate:
a session can only ever reach its own table's most recent bill, inside the
window.

Thirty minutes is enough to pay, photograph, or email a receipt, and short
enough that a session left open on a shared phone does not expose a stranger's
bill an hour later.

---

## 6. Post-order rating

```sql
review_prompts
  id, business_id null,        -- null = platform default
  business_type text null,     -- null = any
  rating_band text,            -- 'low' (1-3) | 'good' (4) | 'great' (5)
  text text

order_ratings
  id, business_id, order_id UNIQUE, table_id,
  stars int, prompt_id null, private_feedback text null, created_at
```

For 10 minutes after completion the diner sees a rating prompt. They tap 1–5
stars, which we store as a **first-party rating** — valuable on its own, per
table, and ours regardless of what happens next.

We then offer three or four predefined review texts matched to the rating band
and business type, editable inline, with a copy-and-open action pointing at
`search.google.com/local/writereview?placeid=<google_place_id>`.

### Two constraints of record

**No API posts a review to Google on a user's behalf.** The Business Profile API
lets an owner *reply*; the Places API only *reads*. Copy-and-deep-link is the
only mechanism that exists, so the design does not pretend otherwise.

**Review gating is not built, deliberately.** Showing the Google path only to
4–5 star raters violates Google's policies and has cost businesses their review
counts. The Google path and the private-feedback path are offered at *every*
rating level, and the low-band predefined texts are honest ones. An owner
wanting the other behaviour is asking for something that damages them.

---

## 7. Endpoints

**Staff**
```
POST  /businesses/:bid/orders/:id/bill        -> generate (idempotent)
GET   /businesses/:bid/orders/:id/bill        -> fetch
GET   /businesses/:bid/bills/:id/pdf
GET   /businesses/:bid/ratings?scope=30d
PATCH /businesses/:bid/tax                     -> tax + service charge config
```

**Diner (table session)**
```
GET  /public/table/bill          -> most recent bill for this table, ≤30 min
GET  /public/table/bill/pdf
POST /public/table/bill/service-charge/remove
GET  /public/table/rating/prompts
POST /public/table/rating        { stars, promptId?, privateFeedback? }
```

---

## 8. Isolation

`bills`, `bill_lines`, and `order_ratings` carry `business_id` and come under the
same RLS policies as everything else. The diner's routes go through narrow
`SECURITY DEFINER` functions scoped to one table, as Phase 2 established, with
the 30-minute and 10-minute windows enforced **in SQL** rather than in the API —
a window checked in application code is a window someone forgets to check.

The isolation suite gains: a table session reading another table's bill, a
session reading its own bill after the window closes, and a session rating an
order it did not place.

---

## 9. Decisions log

| Decision | Chosen | Rejected |
|----------|--------|----------|
| Bill type | Itemised receipt showing tax | Full GST tax invoice; no tax at all |
| Tax rates | Business default + per-item override | Single rate; full HSN table |
| Inclusive pricing | Default true | Default exclusive |
| Service charge | Off by default, removable by the diner | Not built; ordinary charge |
| Rounding | Nearest rupee, shown as a line | Silent rounding |
| Bill mutability | Write once, regenerate returns existing | Recompute on demand |
| Diner window | 30 min, enforced in SQL | Application-level check |
| Review gating | Not built, at any rating | Google link for 4–5 stars only |
