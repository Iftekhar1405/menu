# Sales Records, Bill Export & Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record payment at a new `paid` order status, and give owners a filterable Sales register, a browser-assembled ZIP export (bill PDFs + CSVs), and an Insights analytics page.

**Architecture:** One shared filter schema (`@menu/shared`) is parsed by a new NestJS `sales` module, turned into a single SQL WHERE fragment, and reused by the list, export and analytics endpoints so they always agree on which bills a filter means. All queries run through `prisma.db` inside the per-request tenant transaction, so RLS applies. Because the API is Vercel serverless (30 s, ~4.5 MB), the browser pages export rows as JSON, fetches PDFs 25 at a time as small ZIPs, and assembles the final ZIP with `fflate`.

**Tech Stack:** NestJS 10, Prisma 5 (raw SQL via `Prisma.sql`), Postgres 16, Next.js 15 App Router (client pages), Tailwind, Zod, Vitest, Playwright, `fflate`.

**Spec:** `docs/superpowers/specs/2026-10-03-sales-records-insights-design.md`

## Global Constraints

- Work on branch `feat/sales-insights`; never commit to `master`.
- Do not change `generate_bill`, `bill.pdf.ts`, `receipt.pdf.ts`, `OPEN_STATUSES`, or the `orders_one_open_per_table` index.
- Every new owner route: under `businesses/:bid`, authenticated (no `@Public`), calls `businesses.assertOwns(user.id, bid)` first, queries via `this.prisma.db`.
- Money crosses the wire as strings (Postgres `numeric::text`), never JS floats in the API.
- Report dates are local to the business timezone: `timezoneFor(business.country)`; `to` is inclusive; max span 400 days; financial year 1 April – 31 March.
- PDF batch size: 1–25 bill ids per request. Export rows page: 1000 bills.
- Payment modes: `cash | upi | card | other`; filter adds `unpaid`.
- CSVs: UTF-8 with BOM, RFC 4180 quoting, ISO dates, numbers as plain 2-decimal strings, no currency symbol.
- Copy: the export README and Sales page say "These are receipts showing tax, not GST tax invoices."
- `pnpm --filter @menu/shared build` after any change in `packages/shared` before running api/web.
- Each commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **Midnight in IST** — a bill issued 00:30 IST on 2 Oct is stored as 1 Oct 19:00 UTC; filtering `from=to=2026-10-02` must include it and `2026-10-01` must not. (Test: Task 1 `localRange` spec + Task 4 `billWhere` spec asserting the timezone param.)
2. **Two staff tap Paid at once** — the second must get 409, and the bill's mode must be the first tap's, not overwritten. (Test: Task 3 `markPaid` guarded update + isolation script double-tap probe in Task 7.)
3. **Service charge removed after payment** — a diner removing service charge on a paid bill must be refused, or the recorded amount changes after cash was taken. (Test: Task 2 migration RAISE + Task 14 e2e with service charge on.)
4. **A PDF batch naming another tenant's bill ids** — must 404 the whole batch, never return a partial ZIP. (Test: Task 7 isolation probe; Task 5 unit test on `assertAllFound`.)
5. **Export interrupted mid-way** (network drop on batch 17 of 40) — no ZIP is produced; the user sees an error naming the failure; retry works. (Test: Task 11 `runExport` spec with a failing fake.)

---

## File map

**Shared (`packages/shared/src/`)**
- Create `sales.ts` — payment modes, timezone map, local-date math, presets, `salesFilterSchema`, URL (de)serialisation.
- Create `sales.spec.ts`.
- Modify `index.ts` — `export * from "./sales";`

**API (`apps/api/`)**
- Create `prisma/migrations/20261003000000_order_paid_status/migration.sql`
- Create `prisma/migrations/20261003000100_bill_payment/migration.sql`
- Modify `prisma/schema.prisma` — `paid` in `OrderStatus`, `PaymentMode` enum, two `Bill` columns + index.
- Modify `src/orders/transitions.ts` + `transitions.spec.ts`
- Modify `src/orders/orders.service.ts` — `markPaid`, `collect` scope, `setStatus` refuses `paid`.
- Modify `src/orders/orders.controller.ts` — `POST :id/paid`, `scope=collect`.
- Modify `src/billing/billing.service.ts` — export `shapeBill`, remove `listBills`.
- Modify `src/billing/billing.controller.ts` — remove `GET bills`.
- Create `src/sales/sales-filter.sql.ts` + `sales-filter.sql.spec.ts` — WHERE builder, cursor codec.
- Create `src/sales/sales.service.ts` — list + totals, payment-mode change, export rows, PDF batch.
- Create `src/sales/pdf-batch.ts` + `pdf-batch.spec.ts` — zip of PDFs, `assertAllFound`.
- Create `src/sales/analytics.service.ts`, `src/sales/series.ts` + `series.spec.ts`.
- Create `src/sales/sales.controller.ts` — all `businesses/:bid` sales/analytics routes.
- Modify `src/app.module.ts` — register controller + services.
- Modify `scripts/check-isolation.sh` — new probes.
- Modify `package.json` — add `fflate`.

**Web (`apps/web/`)**
- Modify `lib/order-timeline.ts` (+ spec), `components/order/ordering.tsx` — `paid` labels.
- Create `components/sales/pay-sheet.tsx` — mode picker sheet (board + Sales).
- Modify `app/(app)/orders/page.tsx` — "To collect" column, Paid actions.
- Modify `lib/api-client.ts` — `apiBinary`.
- Create `lib/sales/csv.ts` + `csv.spec.ts`, `lib/sales/export.ts` + `export.spec.ts`, `lib/sales/types.ts`.
- Create `components/sales/filter-bar.tsx`, `use-sales-filter.ts`, `bill-sheet.tsx`, `export-dialog.tsx`.
- Create `app/(app)/sales/page.tsx`, `app/(app)/insights/page.tsx`.
- Create `components/insights/charts.tsx`, `components/insights/kpi.tsx`.
- Modify `app/(app)/layout.tsx` (nav), `app/(app)/dashboard/page.tsx` (Today card).
- Create `e2e/sales.spec.ts`.
- Modify `package.json` — add `fflate`.

**Root**
- Modify `CLAUDE.md` (commit it on this branch).

---

### Task 1: Shared sales module (modes, timezone, periods, filter schema)

**Files:**
- Create: `packages/shared/src/sales.ts`
- Create: `packages/shared/src/sales.spec.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces:
  - `PAYMENT_MODES`, `type PaymentMode`, `PAYMENT_MODE_LABEL: Record<PaymentMode,string>`
  - `PAYMENT_FILTERS` (`[...PAYMENT_MODES, "unpaid"]`), `type PaymentFilter`
  - `timezoneFor(country: string): string`
  - `localToday(tz: string, now?: Date): string` (`YYYY-MM-DD`)
  - `addDays(date: string, n: number): string`
  - `daySpan(from: string, to: string): number` (inclusive count)
  - `type PeriodPreset = "today"|"yesterday"|"this_week"|"this_month"|"last_month"|"this_fy"|"last_fy"`
  - `PERIOD_PRESET_LABEL`, `presetRange(preset, today): { from: string; to: string }`
  - `previousPeriod(range): { from; to }`
  - `bucketFor(range): "day"|"week"|"month"`
  - `MAX_SPAN_DAYS = 400`
  - `salesFilterSchema`, `type SalesFilter`
  - `salesFilterToParams(f: SalesFilter): URLSearchParams`, `paramsToObject(p: URLSearchParams): Record<string, string | string[]>`
  - `markPaidSchema` (`{ mode: PaymentMode }`)

- [ ] **Step 1: Write the failing test**

`packages/shared/src/sales.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  addDays,
  bucketFor,
  daySpan,
  localToday,
  paramsToObject,
  presetRange,
  previousPeriod,
  salesFilterSchema,
  salesFilterToParams,
  timezoneFor,
} from "./sales";

describe("timezoneFor", () => {
  it("maps India to Kolkata and anything unknown to UTC", () => {
    expect(timezoneFor("IN")).toBe("Asia/Kolkata");
    expect(timezoneFor("in")).toBe("Asia/Kolkata");
    expect(timezoneFor("ZZ")).toBe("UTC");
  });
});

describe("localToday", () => {
  it("is already tomorrow in IST at 19:00 UTC", () => {
    const now = new Date("2026-10-01T19:00:00Z"); // 00:30 IST on 2 Oct
    expect(localToday("Asia/Kolkata", now)).toBe("2026-10-02");
    expect(localToday("UTC", now)).toBe("2026-10-01");
  });
});

describe("date math", () => {
  it("adds days across month and year ends", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("counts both ends", () => {
    expect(daySpan("2026-10-01", "2026-10-01")).toBe(1);
    expect(daySpan("2026-10-01", "2026-10-31")).toBe(31);
  });
});

describe("presetRange", () => {
  const today = "2026-10-03"; // a Saturday
  it("starts the week on Monday", () => {
    expect(presetRange("this_week", today)).toEqual({ from: "2026-09-28", to: today });
  });
  it("handles months", () => {
    expect(presetRange("this_month", today)).toEqual({ from: "2026-10-01", to: today });
    expect(presetRange("last_month", today)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(presetRange("last_month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
  it("uses April–March financial years", () => {
    expect(presetRange("this_fy", today)).toEqual({ from: "2026-04-01", to: today });
    expect(presetRange("this_fy", "2026-02-10")).toEqual({ from: "2025-04-01", to: "2026-02-10" });
    expect(presetRange("last_fy", today)).toEqual({ from: "2025-04-01", to: "2026-03-31" });
  });
  it("does today and yesterday", () => {
    expect(presetRange("today", today)).toEqual({ from: today, to: today });
    expect(presetRange("yesterday", today)).toEqual({ from: "2026-10-02", to: "2026-10-02" });
  });
});

describe("previousPeriod", () => {
  it("is the same length, immediately before", () => {
    expect(previousPeriod({ from: "2026-10-01", to: "2026-10-31" })).toEqual({
      from: "2026-08-31",
      to: "2026-09-30",
    });
    expect(previousPeriod({ from: "2026-10-03", to: "2026-10-03" })).toEqual({
      from: "2026-10-02",
      to: "2026-10-02",
    });
  });
});

describe("bucketFor", () => {
  it("chooses day, week, month by span", () => {
    expect(bucketFor({ from: "2026-10-01", to: "2026-11-30" })).toBe("day"); // 61
    expect(bucketFor({ from: "2026-10-01", to: "2026-12-31" })).toBe("week"); // 92
    expect(bucketFor({ from: "2026-04-01", to: "2027-03-31" })).toBe("month");
  });
});

describe("salesFilterSchema", () => {
  it("accepts a Nest-style query object with repeated params", () => {
    const parsed = salesFilterSchema.parse({
      from: "2026-10-01",
      to: "2026-10-31",
      modes: ["cash", "unpaid"],
      tables: "Balcony 3",
      minTotal: "100",
      maxTotal: "",
      billNo: "",
    });
    expect(parsed.modes).toEqual(["cash", "unpaid"]);
    expect(parsed.tables).toEqual(["Balcony 3"]);
    expect(parsed.minTotal).toBe(100);
    expect(parsed.maxTotal).toBeUndefined();
    expect(parsed.billNo).toBeUndefined();
  });
  it("refuses a reversed or over-long range and bad dates", () => {
    expect(salesFilterSchema.safeParse({ from: "2026-10-31", to: "2026-10-01" }).success).toBe(false);
    expect(salesFilterSchema.safeParse({ from: "2025-01-01", to: "2026-10-01" }).success).toBe(false);
    expect(salesFilterSchema.safeParse({ from: "2026-02-30", to: "2026-03-01" }).success).toBe(false);
  });
  it("refuses min above max and unknown modes", () => {
    expect(
      salesFilterSchema.safeParse({ from: "2026-10-01", to: "2026-10-02", minTotal: "500", maxTotal: "100" }).success,
    ).toBe(false);
    expect(salesFilterSchema.safeParse({ from: "2026-10-01", to: "2026-10-02", modes: ["bitcoin"] }).success).toBe(false);
  });
  it("round-trips through URL params, including a label with a comma", () => {
    const f = salesFilterSchema.parse({
      from: "2026-10-01",
      to: "2026-10-31",
      modes: ["upi", "card"],
      tables: ["Screen 2, Row F", "12"],
      billNo: "42",
    });
    const back = salesFilterSchema.parse(paramsToObject(salesFilterToParams(f)));
    expect(back).toEqual(f);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @menu/shared exec vitest run src/sales.spec.ts`
Expected: FAIL — `Cannot find module './sales'`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/sales.ts`:

```ts
import { z } from "zod";

/* ── Payment ─────────────────────────────────────────────────────────────── */

/** How a bill was settled. Cash vs everything else matters for presumptive tax. */
export const PAYMENT_MODES = ["cash", "upi", "card", "other"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const PAYMENT_MODE_LABEL: Record<PaymentMode, string> = {
  cash: "Cash",
  upi: "UPI",
  card: "Card",
  other: "Other",
};

/** Filter values: a mode, or `unpaid` for bills not marked paid yet. */
export const PAYMENT_FILTERS = [...PAYMENT_MODES, "unpaid"] as const;
export type PaymentFilter = (typeof PAYMENT_FILTERS)[number];

export const markPaidSchema = z.object({ mode: z.enum(PAYMENT_MODES) });
export type MarkPaidInput = z.infer<typeof markPaidSchema>;

/* ── Time ────────────────────────────────────────────────────────────────── */

/**
 * Report timezone from the business's country. Single-zone countries only;
 * anything else falls back to UTC rather than guessing a zone.
 */
const COUNTRY_TZ: Record<string, string> = {
  IN: "Asia/Kolkata",
  AE: "Asia/Dubai",
  SG: "Asia/Singapore",
  NP: "Asia/Kathmandu",
  BD: "Asia/Dhaka",
  LK: "Asia/Colombo",
  GB: "Europe/London",
};

export function timezoneFor(country: string): string {
  return COUNTRY_TZ[country.toUpperCase()] ?? "UTC";
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date as the business sees it. */
export function localToday(tz: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function toUtc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

/** Days from `from` to `to`, both included. */
export function daySpan(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000) + 1;
}

function isRealDate(s: string): boolean {
  return ISO_DATE.test(s) && fromUtc(toUtc(s)) === s;
}

export const PERIOD_PRESETS = [
  "today",
  "yesterday",
  "this_week",
  "this_month",
  "last_month",
  "this_fy",
  "last_fy",
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const PERIOD_PRESET_LABEL: Record<PeriodPreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This week",
  this_month: "This month",
  last_month: "Last month",
  this_fy: "This FY",
  last_fy: "Last FY",
};

export interface DateRange {
  from: string;
  to: string;
}

/** Financial year start (1 April) for the FY containing `date`. */
function fyStart(date: string): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return `${m >= 4 ? y : y - 1}-04-01`;
}

export function presetRange(preset: PeriodPreset, today: string): DateRange {
  const monthStart = `${today.slice(0, 7)}-01`;
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const d = addDays(today, -1);
      return { from: d, to: d };
    }
    case "this_week": {
      const dow = toUtc(today).getUTCDay(); // 0 = Sunday
      return { from: addDays(today, -((dow + 6) % 7)), to: today };
    }
    case "this_month":
      return { from: monthStart, to: today };
    case "last_month": {
      const lastDay = addDays(monthStart, -1);
      return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay };
    }
    case "this_fy":
      return { from: fyStart(today), to: today };
    case "last_fy": {
      const start = fyStart(today);
      return { from: fyStart(addDays(start, -1)), to: addDays(start, -1) };
    }
  }
  throw new Error(`Unknown preset ${preset as string}`);
}

export function previousPeriod(range: DateRange): DateRange {
  const len = daySpan(range.from, range.to);
  return { from: addDays(range.from, -len), to: addDays(range.from, -1) };
}

export function bucketFor(range: DateRange): "day" | "week" | "month" {
  const len = daySpan(range.from, range.to);
  if (len <= 62) return "day";
  if (len <= 190) return "week";
  return "month";
}

export const MAX_SPAN_DAYS = 400;

/* ── Filter ──────────────────────────────────────────────────────────────── */

const isoDate = z.string().refine(isRealDate, "Use a real date (YYYY-MM-DD)");

/** Query strings arrive as a string, an array (repeated param), or not at all. */
function many<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess(
    (v) => (v === undefined || v === "" ? undefined : Array.isArray(v) ? v : [v]),
    z.array(item).max(100).optional(),
  );
}

/** "" from an empty form field means "not set", not zero. */
function optionalNumber(schema: z.ZodNumber) {
  return z.preprocess((v) => (v === "" || v === undefined || v === null ? undefined : Number(v)), schema.optional());
}

export const salesFilterSchema = z
  .object({
    from: isoDate,
    to: isoDate,
    modes: many(z.enum(PAYMENT_FILTERS)),
    tables: many(z.string().trim().min(1).max(60)),
    categoryId: z.string().uuid().optional(),
    menuItemId: z.string().uuid().optional(),
    minTotal: optionalNumber(z.number().min(0).max(10_000_000)),
    maxTotal: optionalNumber(z.number().min(0).max(10_000_000)),
    billNo: optionalNumber(z.number().int().positive()),
  })
  .refine((f) => f.from <= f.to, { message: "The start date is after the end date", path: ["from"] })
  .refine((f) => daySpan(f.from, f.to) <= MAX_SPAN_DAYS, {
    message: `Choose at most ${MAX_SPAN_DAYS} days`,
    path: ["to"],
  })
  .refine((f) => f.minTotal === undefined || f.maxTotal === undefined || f.minTotal <= f.maxTotal, {
    message: "Minimum is above maximum",
    path: ["minTotal"],
  });

export type SalesFilter = z.infer<typeof salesFilterSchema>;

/** Repeated params for lists, so a table label containing a comma survives. */
export function salesFilterToParams(f: SalesFilter): URLSearchParams {
  const p = new URLSearchParams();
  p.set("from", f.from);
  p.set("to", f.to);
  for (const m of f.modes ?? []) p.append("modes", m);
  for (const t of f.tables ?? []) p.append("tables", t);
  if (f.categoryId) p.set("categoryId", f.categoryId);
  if (f.menuItemId) p.set("menuItemId", f.menuItemId);
  if (f.minTotal !== undefined) p.set("minTotal", String(f.minTotal));
  if (f.maxTotal !== undefined) p.set("maxTotal", String(f.maxTotal));
  if (f.billNo !== undefined) p.set("billNo", String(f.billNo));
  return p;
}

const LIST_KEYS = new Set(["modes", "tables"]);

/** The shape Express gives Nest for the same query string. */
export function paramsToObject(p: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(p.keys())) {
    out[key] = LIST_KEYS.has(key) ? p.getAll(key) : p.get(key)!;
  }
  return out;
}
```

Add to `packages/shared/src/index.ts`:

```ts
export * from "./sales";
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @menu/shared exec vitest run src/sales.spec.ts && pnpm --filter @menu/shared lint && pnpm --filter @menu/shared build`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/sales.ts packages/shared/src/sales.spec.ts packages/shared/src/index.ts
git commit -m "feat(shared): payment modes, report periods and the sales filter

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `paid` status, payment columns, and SQL functions that must learn `paid`

**Files:**
- Create: `apps/api/prisma/migrations/20261003000000_order_paid_status/migration.sql`
- Create: `apps/api/prisma/migrations/20261003000100_bill_payment/migration.sql`
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/orders/transitions.ts`
- Test: `apps/api/src/orders/transitions.spec.ts`

**Interfaces:**
- Produces: Prisma `OrderStatus.paid`, `PaymentMode` enum, `Bill.paymentMode: PaymentMode | null`, `Bill.paidAt: Date | null`; `ALLOWED_TRANSITIONS` with `paid`; exported `FINISHED_STATUSES = ["completed","paid","cancelled"]`.

- [ ] **Step 1: Write the failing test** — append to `apps/api/src/orders/transitions.spec.ts` inside the `describe`:

```ts
  it("lets any open or served order be marked paid, and nothing leave paid", () => {
    for (const s of [...OPEN_STATUSES, "completed"] as OrderStatus[]) {
      expect(canTransition(s, "paid")).toBe(true);
    }
    expect(ALLOWED_TRANSITIONS.paid).toEqual([]);
    expect(canTransition("cancelled", "paid")).toBe(false);
  });

  it("does not count paid as open", () => {
    expect(OPEN_STATUSES).not.toContain("paid");
  });
```

And change the `refuses to reopen a finished order` test's first expectation to:

```ts
    expect(ALLOWED_TRANSITIONS.completed).toEqual(["paid"]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @menu/api exec vitest run src/orders/transitions.spec.ts`
Expected: FAIL — TS/assertion errors on `"paid"`.

- [ ] **Step 3: Migration A** — `apps/api/prisma/migrations/20261003000000_order_paid_status/migration.sql`:

```sql
-- The `paid` status.
--
-- Alone in its own migration for the same reason as `accepted`: Postgres
-- will not let a new enum value be used in the transaction that added it,
-- and the functions that name 'paid' live in the next folder.
--
-- AFTER 'completed': listForBusiness sorts by status, and a paid order
-- belongs after a served one.
ALTER TYPE "OrderStatus" ADD VALUE 'paid' AFTER 'completed';
```

- [ ] **Step 4: Migration B** — `apps/api/prisma/migrations/20261003000100_bill_payment/migration.sql`. Write the header and DDL:

```sql
-- Payment on the bill, and every function that treats 'completed' as the
-- finished state taught that 'paid' is finished too.
--
-- WARNING carried forward from transitions.ts: status lists are written out
-- by hand in SQL. OPEN statuses are unchanged here — 'paid' is not open — so
-- orders_one_open_per_table is untouched.

CREATE TYPE "PaymentMode" AS ENUM ('cash', 'upi', 'card', 'other');

ALTER TABLE "bills"
  ADD COLUMN "payment_mode" "PaymentMode",
  ADD COLUMN "paid_at" TIMESTAMPTZ(6),
  -- Paid means both or neither. A mode with no time, or a time with no mode,
  -- is a half-written payment.
  ADD CONSTRAINT "bills_paid_consistent"
    CHECK (("payment_mode" IS NULL) = ("paid_at" IS NULL));

CREATE INDEX "bills_business_id_payment_mode_issued_at_idx"
  ON "bills" ("business_id", "payment_mode", "issued_at");
```

Then append, in this order:

**(a) `place_table_round`** — copy the entire `CREATE OR REPLACE FUNCTION place_table_round(...) ... $$;` block verbatim from `apps/api/prisma/migrations/20260928000000_order_round_fixes/migration.sql` (lines 16–181), changing exactly one line inside the `IF v_running_enabled THEN` block:

```sql
         AND status = 'completed'
```
becomes
```sql
         AND status IN ('completed', 'paid')
```

**(b) `get_table_order`** — copy the entire function from the same file (lines 188–end) verbatim, changing exactly the closed-order predicate:

```sql
      (o.status IN ('completed', 'cancelled')
```
becomes
```sql
      (o.status IN ('completed', 'paid', 'cancelled')
```

**(c) `get_ratable_order`** — full replacement:

```sql
CREATE OR REPLACE FUNCTION get_ratable_order(p_table_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'orderId',       o.id,
    'businessId',    o.business_id,
    'googlePlaceId', b.google_place_id,
    'businessName',  b.name,
    'businessType',  b.type
  )
  FROM orders o
  JOIN businesses b ON b.id = o.business_id
  WHERE o.table_id = p_table_id
    AND o.status IN ('completed', 'paid')
    AND o.completed_at > now() - interval '10 minutes'
    AND NOT EXISTS (SELECT 1 FROM order_ratings r WHERE r.order_id = o.id)
  ORDER BY o.completed_at DESC
  LIMIT 1;
$fn$;
```

**(d) `remove_service_charge`** — copy the function verbatim from `apps/api/prisma/migrations/20260830085723_billing/migration.sql` (lines 353–399) and insert, directly after the `IF v_bill.service_charge = 0 THEN ... END IF;` block:

```sql
  -- Money has already changed hands for this amount. Removing the charge now
  -- would leave a recorded payment that no longer matches its bill.
  IF v_bill.paid_at IS NOT NULL THEN
    RAISE EXCEPTION 'This bill is already paid — ask a member of staff'
      USING ERRCODE = 'check_violation';
  END IF;
```

- [ ] **Step 5: Prisma schema** — in `apps/api/prisma/schema.prisma`:

In `enum OrderStatus`, after `completed`:

```prisma
  /// Settled. Recorded with a payment mode on the bill; terminal.
  paid
```

Before `model Bill`:

```prisma
enum PaymentMode {
  cash
  upi
  card
  other
}
```

Inside `model Bill`, after `total`:

```prisma
  /// Null until the order is marked paid. Both or neither (CHECK in SQL).
  paymentMode   PaymentMode? @map("payment_mode")
  paidAt        DateTime?    @map("paid_at") @db.Timestamptz(6)
```

and after `@@index([businessId, issuedAt])`:

```prisma
  @@index([businessId, paymentMode, issuedAt])
```

- [ ] **Step 6: transitions.ts** — replace `ORDER_STATUSES` and `ALLOWED_TRANSITIONS`, add `FINISHED_STATUSES`:

```ts
export const ORDER_STATUSES = [
  "placed",
  "accepted",
  "preparing",
  "ready",
  "completed",
  "paid",
  "cancelled",
] as const satisfies readonly OrderStatus[];
```

Update the WARNING comment above `OPEN_STATUSES` to add: "Statuses meaning *finished* (`completed`, `paid`) are likewise listed by hand in `place_table_round`, `get_table_order` and `get_ratable_order` — see 20261003000100_bill_payment."

```ts
/** Served or settled — the order is over. Mirrors the SQL lists above. */
export const FINISHED_STATUSES: OrderStatus[] = ["completed", "paid", "cancelled"];

export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  placed: ["accepted", "preparing", "ready", "completed", "paid", "cancelled"],
  accepted: ["preparing", "ready", "completed", "paid", "cancelled"],
  preparing: ["ready", "completed", "paid", "cancelled"],
  ready: ["completed", "paid", "cancelled"],
  // Served food still has to be paid for; that is the only way forward.
  completed: ["paid"],
  // A finished order stays finished. Reopening one would put two open orders
  // on a table that has since seated new diners.
  paid: [],
  cancelled: [],
};
```

- [ ] **Step 7: Apply and verify the database**

Run (Postgres up via `pnpm db:up`):
```bash
pnpm --filter @menu/api exec prisma migrate dev --skip-seed
pnpm --filter @menu/api exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code
```
Expected: both migrations applied; `migrate dev` does **not** generate a new migration; `migrate diff` exits 0 (no drift). If `migrate dev` proposes an extra migration, the schema.prisma names don't match the SQL — fix names, don't accept the generated one.

Then verify the trigger logs `paid` and the functions compile:
```bash
docker exec menu-db psql -U menu -d menu -c "SELECT proname FROM pg_proc WHERE proname IN ('place_table_round','get_table_order','get_ratable_order','remove_service_charge');"
```
Expected: 4 rows.

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm --filter @menu/api exec vitest run src/orders/transitions.spec.ts && pnpm --filter @menu/api lint`
Expected: PASS. `lint` may fail where code switches exhaustively over `OrderStatus` — fix each by treating `paid` like `completed`.

- [ ] **Step 9: Commit**

```bash
git add apps/api/prisma apps/api/src/orders/transitions.ts apps/api/src/orders/transitions.spec.ts
git commit -m "feat(api): paid order status and payment mode on bills

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Mark paid, and the board's "collect" scope

**Files:**
- Modify: `apps/api/src/orders/orders.service.ts`
- Modify: `apps/api/src/orders/orders.controller.ts`
- Modify: `apps/api/src/billing/billing.service.ts` (export `shapeBill`)
- Test: `apps/api/src/orders/mark-paid.spec.ts`

**Interfaces:**
- Consumes: `markPaidSchema`, `PaymentMode` (Task 1); `canTransition` (Task 2).
- Produces:
  - `OrdersService.markPaid(userId, businessId, orderId, mode: PaymentMode): Promise<{ order; bill: Bill }>`
  - `OrdersService.listForBusiness(userId, businessId, scope: "open" | "today" | "collect")` — `collect` = `status = completed` and `completedAt` within 24 h, each with `bill: { id, total } | null`.
  - Route `POST businesses/:bid/orders/:id/paid` body `{ mode }`.
  - `export function shapeBill(...)` from `billing.service.ts`.

- [ ] **Step 1: Write the failing test** — `apps/api/src/orders/mark-paid.spec.ts`. Use a fake Prisma `db` that records calls, mirroring `tenant-context.spec.ts`'s style:

```ts
import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { OrdersService } from "./orders.service";

function setup(order: { id: string; status: string; completedAt: Date | null; tableId: string } | null, updatedCount = 1) {
  const calls: string[] = [];
  const db = {
    order: {
      findFirst: vi.fn(async () => order),
      updateMany: vi.fn(async () => {
        calls.push("order.updateMany");
        return { count: updatedCount };
      }),
      findUniqueOrThrow: vi.fn(async () => ({ ...order, status: "paid", table: { id: "t", label: "1" }, items: [], cancellations: [] })),
    },
    bill: {
      updateMany: vi.fn(async () => {
        calls.push("bill.updateMany");
        return { count: 1 };
      }),
      findFirstOrThrow: vi.fn(async () => ({
        id: "b", billNumber: 1, tableLabel: "1", issuedAt: new Date(), currency: "INR", taxLabel: "GST",
        pricesIncludeTax: true, businessSnapshot: {}, receiptFooter: null, subtotal: "100", taxTotal: "5",
        serviceCharge: "0", serviceChargeRate: "0", roundOff: "0", total: "105", lines: [],
        paymentMode: "upi", paidAt: new Date(),
      })),
    },
    $queryRaw: vi.fn(async () => {
      calls.push("generate_bill");
      return [];
    }),
  };
  const service = new OrdersService(
    { db } as never,
    { assertOwns: vi.fn(async () => ({ id: "biz" })) } as never,
    {} as never,
    { announceStatus: vi.fn(async () => undefined) } as never,
  );
  return { service, db, calls };
}

describe("markPaid", () => {
  it("bills, records the mode, then closes the order — in that order", async () => {
    const { service, calls, db } = setup({ id: "o", status: "completed", completedAt: new Date(), tableId: "t" });
    await service.markPaid("u", "biz", "o", "upi");
    expect(calls).toEqual(["generate_bill", "bill.updateMany", "order.updateMany"]);
    expect(db.bill.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: "o", businessId: "biz", paidAt: null } }),
    );
  });

  it("sets the served time when a counter order is paid straight from open", async () => {
    const { service, db } = setup({ id: "o", status: "placed", completedAt: null, tableId: "t" });
    await service.markPaid("u", "biz", "o", "cash");
    const arg = db.order.updateMany.mock.calls[0]![0] as { data: { completedAt: Date } };
    expect(arg.data.completedAt).toBeInstanceOf(Date);
  });

  it("refuses a cancelled order and an already-paid one", async () => {
    await expect(setup({ id: "o", status: "cancelled", completedAt: null, tableId: "t" }).service.markPaid("u", "biz", "o", "cash"))
      .rejects.toBeInstanceOf(ConflictException);
    await expect(setup({ id: "o", status: "paid", completedAt: new Date(), tableId: "t" }).service.markPaid("u", "biz", "o", "cash"))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it("loses a race cleanly: the second tap gets 409", async () => {
    const { service } = setup({ id: "o", status: "completed", completedAt: new Date(), tableId: "t" }, 0);
    await expect(service.markPaid("u", "biz", "o", "card")).rejects.toBeInstanceOf(ConflictException);
  });

  it("404s an order that is not this business's", async () => {
    await expect(setup(null).service.markPaid("u", "biz", "o", "cash")).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @menu/api exec vitest run src/orders/mark-paid.spec.ts`
Expected: FAIL — `service.markPaid is not a function`.

- [ ] **Step 3: Implement**

In `billing.service.ts` change `function shapeBill(` to `export function shapeBill(` and add to its parameter type and return:

```ts
  paymentMode?: string | null;
  paidAt?: Date | null;
```
```ts
    paymentMode: bill.paymentMode ?? null,
    paidAt: bill.paidAt ? bill.paidAt.toISOString() : null,
```
and to `interface Bill`:
```ts
  paymentMode: "cash" | "upi" | "card" | "other" | null;
  paidAt: string | null;
```

In `orders.service.ts`: import `canTransition` from `./transitions`, `shapeBill` from `../billing/billing.service`, `type PaymentMode` from `@menu/shared`. Add the method after `setStatus`:

```ts
  /**
   * Settles an order: bills it if it has not been, records how it was paid,
   * and closes it — one transaction (the request's tenant transaction).
   *
   * The order update is guarded on the status we read. Two staff tapping Paid
   * together both pass the first check; only one matches the guarded update,
   * and the other gets a 409 and its whole transaction — including its bill
   * write — rolls back.
   */
  async markPaid(userId: string, businessId: string, orderId: string, mode: PaymentMode) {
    await this.businesses.assertOwns(userId, businessId);

    const order = await this.prisma.db.order.findFirst({
      where: { id: orderId, businessId },
      select: { id: true, status: true, completedAt: true, tableId: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (!canTransition(order.status, "paid")) {
      throw new ConflictException(`An order that is ${order.status} cannot be marked paid`);
    }

    // Idempotent: returns the existing bill for an already-served order.
    await this.prisma.db.$queryRaw`SELECT generate_bill(${orderId}::uuid, ${businessId}::uuid)`;

    const now = new Date();
    await this.prisma.db.bill.updateMany({
      where: { orderId, businessId, paidAt: null },
      data: { paymentMode: mode, paidAt: now },
    });

    const moved = await this.prisma.db.order.updateMany({
      where: { id: orderId, businessId, status: order.status },
      data: { status: "paid", completedAt: order.completedAt ?? now },
    });
    if (moved.count !== 1) {
      throw new ConflictException("Someone else just updated this order — refresh and try again");
    }

    const [updated, bill] = await Promise.all([
      this.prisma.db.order.findUniqueOrThrow({
        where: { id: orderId },
        include: {
          table: { select: { id: true, label: true } },
          items: { orderBy: [{ batch: "asc" }, { createdAt: "asc" }] },
          cancellations: { orderBy: { createdAt: "asc" } },
        },
      }),
      this.prisma.db.bill.findFirstOrThrow({
        where: { orderId, businessId },
        include: { lines: { orderBy: { position: "asc" } } },
      }),
    ]);

    await this.notifications.announceStatus(order.tableId);
    return { order: updated, bill: shapeBill(bill) };
  }
```

In `setStatus`, directly after the `if (!order) throw ...` line, add:

```ts
    // Paid needs a payment mode, so it has its own route.
    if (next === "paid") {
      throw new BadRequestException("Use the Paid action to record how it was paid");
    }
```
(import `BadRequestException` if not already imported).

In `listForBusiness`, widen the scope type to `"open" | "today" | "collect"` and replace the `where`:

```ts
      where: {
        businessId,
        ...(scope === "open"
          ? { status: { in: OPEN_STATUSES } }
          : scope === "collect"
            ? // Served, not yet paid. A day back is enough for the board;
              // anything older is chased from the Sales page.
              { status: "completed", completedAt: { gte: new Date(Date.now() - 86_400_000) } }
            : { businessDay: today }),
      },
```
and add to its `include`:
```ts
        bill: { select: { id: true, total: true, paymentMode: true } },
```

In `orders.controller.ts` `OrdersController`: change the list handler so `scope` accepts `collect`:

```ts
    @Query("scope") scope: "open" | "today" | "collect" = "open",
  ) {
    return this.orders.listForBusiness(
      user.id,
      bid,
      scope === "today" || scope === "collect" ? scope : "open",
    );
```

Add the route (import `markPaidSchema, type MarkPaidInput` from `@menu/shared`):

```ts
  @Post(":id/paid")
  markPaid(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("id") id: string,
    @Body(new ZodBody(markPaidSchema)) body: MarkPaidInput,
  ) {
    return this.orders.markPaid(user.id, bid, id, body.mode);
  }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @menu/api exec vitest run src/orders && pnpm --filter @menu/api lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/orders apps/api/src/billing/billing.service.ts
git commit -m "feat(api): mark an order paid with a payment mode

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Filter → SQL builder, Sales list with totals, payment-mode correction

**Files:**
- Create: `apps/api/src/sales/sales-filter.sql.ts`
- Create: `apps/api/src/sales/sales-filter.sql.spec.ts`
- Create: `apps/api/src/sales/sales.service.ts`
- Create: `apps/api/src/sales/sales.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/billing/billing.controller.ts`, `billing.service.ts` (remove `GET bills` / `listBills`)

**Interfaces:**
- Consumes: `SalesFilter`, `salesFilterSchema`, `addDays`, `timezoneFor`, `markPaidSchema` (Task 1).
- Produces:
  - `billWhere(f: SalesFilter, businessId: string, tz: string): Prisma.Sql` — conditions on alias `b` (table `bills`).
  - `lineMatch(f: SalesFilter): Prisma.Sql` — conditions on alias `cat` (`cat.category_id`, `cat.menu_item_id`) for item-level queries; `TRUE` when no item/category filter.
  - `LINE_CATEGORY_JOIN: Prisma.Sql` — `LEFT JOIN LATERAL (...) cat ON true` for alias `l` (bill_lines) joined to `b`.
  - `encodeCursor({ issuedAt: Date; id: string }): string`, `decodeCursor(s: string): { issuedAt: Date; id: string } | null`
  - `SalesService.list(userId, bid, filter, cursor?): Promise<{ bills: BillRow[]; nextCursor: string | null; totals: Totals }>`
  - `SalesService.changePaymentMode(userId, bid, billId, mode): Promise<{ id; paymentMode; paidAt }>`
  - `SalesService.context(userId, bid): Promise<{ tz: string; business: Business }>`
  - Types `BillRow`, `Totals` exported from `sales.service.ts`.
  - Routes: `GET businesses/:bid/bills`, `PATCH businesses/:bid/bills/:billId/payment-mode`.

- [ ] **Step 1: Write the failing test** — `apps/api/src/sales/sales-filter.sql.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { billWhere, decodeCursor, encodeCursor, lineMatch } from "./sales-filter.sql";

const base = { from: "2026-10-02", to: "2026-10-02" };
const BIZ = "11111111-1111-1111-1111-111111111111";

describe("billWhere", () => {
  it("scopes to the business and a local-day range in the business timezone", () => {
    const w = billWhere(base, BIZ, "Asia/Kolkata");
    expect(w.sql).toContain("b.business_id = ");
    expect(w.sql).toContain("AT TIME ZONE");
    // to is inclusive: the upper bound is the next local midnight.
    expect(w.values).toEqual([BIZ, "2026-10-02", "Asia/Kolkata", "2026-10-03", "Asia/Kolkata"]);
  });

  it("ORs modes with unpaid", () => {
    const w = billWhere({ ...base, modes: ["cash", "unpaid"] }, BIZ, "UTC");
    expect(w.sql).toMatch(/b\.payment_mode::text IN \(\?\) OR b\.payment_mode IS NULL/);
    expect(w.values).toContain("cash");
  });

  it("filters only on unpaid when that is all that is asked", () => {
    const w = billWhere({ ...base, modes: ["unpaid"] }, BIZ, "UTC");
    expect(w.sql).toContain("(b.payment_mode IS NULL)");
    expect(w.sql).not.toContain("IN (");
  });

  it("adds tables, totals, bill number, item and category", () => {
    const w = billWhere(
      {
        ...base,
        tables: ["12", "Balcony 3"],
        minTotal: 100,
        maxTotal: 500,
        billNo: 42,
        menuItemId: "22222222-2222-2222-2222-222222222222",
        categoryId: "33333333-3333-3333-3333-333333333333",
      },
      BIZ,
      "UTC",
    );
    expect(w.sql).toContain("b.table_label IN (");
    expect(w.sql).toContain("b.total >= ");
    expect(w.sql).toContain("b.total <= ");
    expect(w.sql).toContain("b.bill_number = ");
    expect(w.sql).toContain("oi.menu_item_id = ");
    expect(w.sql).toContain("mi.category_id = ");
    expect(w.values).toEqual(expect.arrayContaining(["12", "Balcony 3", 100, 500, 42]));
  });

  it("never interpolates user text into the SQL string", () => {
    const evil = "x'); DROP TABLE bills; --";
    const w = billWhere({ ...base, tables: [evil] }, BIZ, "UTC");
    expect(w.sql).not.toContain("DROP");
    expect(w.values).toContain(evil);
  });
});

describe("lineMatch", () => {
  it("is TRUE with no item filter", () => {
    expect(lineMatch(base).sql.trim()).toBe("TRUE");
  });
  it("matches category on the lateral alias", () => {
    expect(lineMatch({ ...base, categoryId: "33333333-3333-3333-3333-333333333333" }).sql).toContain("cat.category_id = ");
  });
});

describe("cursor", () => {
  it("round-trips and rejects junk", () => {
    const c = { issuedAt: new Date("2026-10-02T10:00:00.123Z"), id: "44444444-4444-4444-4444-444444444444" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor("not-a-cursor")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @menu/api exec vitest run src/sales/sales-filter.sql.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the builder** — `apps/api/src/sales/sales-filter.sql.ts`:

```ts
import { Prisma } from "@prisma/client";
import { addDays, type SalesFilter } from "@menu/shared";

/**
 * The one place a sales filter becomes SQL.
 *
 * The list, the export and every analytics query build their WHERE from
 * here, so the three can never disagree about which bills "October, UPI,
 * table 12" means. Every value is a bind parameter; nothing a user typed is
 * ever part of the SQL string.
 *
 * Conditions are on alias `b` (bills).
 */
export function billWhere(f: SalesFilter, businessId: string, tz: string): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`b.business_id = ${businessId}::uuid`,
    // A local date at local midnight, as an instant. `to` is inclusive, so
    // the upper bound is the following local midnight.
    Prisma.sql`b.issued_at >= (${f.from}::date::timestamp AT TIME ZONE ${tz})`,
    Prisma.sql`b.issued_at < (${addDays(f.to, 1)}::date::timestamp AT TIME ZONE ${tz})`,
  ];

  if (f.modes?.length) {
    const modes = f.modes.filter((m) => m !== "unpaid");
    const ors: Prisma.Sql[] = [];
    if (modes.length) ors.push(Prisma.sql`b.payment_mode::text IN (${Prisma.join(modes)})`);
    if (f.modes.includes("unpaid")) ors.push(Prisma.sql`b.payment_mode IS NULL`);
    parts.push(Prisma.sql`(${Prisma.join(ors, " OR ")})`);
  }
  if (f.tables?.length) parts.push(Prisma.sql`b.table_label IN (${Prisma.join(f.tables)})`);
  if (f.minTotal !== undefined) parts.push(Prisma.sql`b.total >= ${f.minTotal}`);
  if (f.maxTotal !== undefined) parts.push(Prisma.sql`b.total <= ${f.maxTotal}`);
  if (f.billNo !== undefined) parts.push(Prisma.sql`b.bill_number = ${f.billNo}`);

  // Bill lines carry only a name, so "bills with a coffee" goes through the
  // order's items to the dish's *current* category.
  if (f.menuItemId) {
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM order_items oi
      WHERE oi.order_id = b.order_id AND oi.menu_item_id = ${f.menuItemId}::uuid)`);
  }
  if (f.categoryId) {
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM order_items oi JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.order_id = b.order_id AND mi.category_id = ${f.categoryId}::uuid)`);
  }

  return Prisma.join(parts, " AND ");
}

/**
 * For item-level queries over `bill_lines l` joined to `bills b`: resolves
 * each line to its dish and current category. A line maps to the order item
 * it was generated from by name and variant (generate_bill writes one line
 * per order item). A deleted dish leaves both ids null.
 */
export const LINE_CATEGORY_JOIN = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT oi.menu_item_id, mi.category_id, c.name AS category_name
    FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    LEFT JOIN menu_categories c ON c.id = mi.category_id
    WHERE oi.order_id = b.order_id
      AND oi.name_snapshot = l.name
      AND oi.variant_snapshot IS NOT DISTINCT FROM l.variant
    LIMIT 1
  ) cat ON true`;

/** Restricts item-level rows to the filtered item/category. */
export function lineMatch(f: SalesFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (f.menuItemId) parts.push(Prisma.sql`cat.menu_item_id = ${f.menuItemId}::uuid`);
  if (f.categoryId) parts.push(Prisma.sql`cat.category_id = ${f.categoryId}::uuid`);
  return parts.length ? Prisma.join(parts, " AND ") : Prisma.sql`TRUE`;
}

export interface Cursor {
  issuedAt: Date;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.issuedAt.toISOString()}|${c.id}`).toString("base64url");
}

export function decodeCursor(s: string): Cursor | null {
  try {
    const [iso, id] = Buffer.from(s, "base64url").toString().split("|");
    const issuedAt = new Date(iso ?? "");
    if (!id || Number.isNaN(issuedAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { issuedAt, id };
  } catch {
    return null;
  }
}

/** Keyset condition for newest-first pages. */
export function afterCursor(c: Cursor | null): Prisma.Sql {
  return c ? Prisma.sql`(b.issued_at, b.id) < (${c.issuedAt}::timestamptz, ${c.id}::uuid)` : Prisma.sql`TRUE`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @menu/api exec vitest run src/sales/sales-filter.sql.spec.ts`
Expected: PASS. If the exact `values` order assertion in the first test differs (Prisma flattens in template order), adjust the implementation, not the test — the order shown is template order.

- [ ] **Step 5: Service** — `apps/api/src/sales/sales.service.ts`:

```ts
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { timezoneFor, type PaymentMode, type SalesFilter } from "@menu/shared";
import { BusinessesService } from "../businesses/businesses.service";
import { PrismaService } from "../prisma/prisma.service";
import { afterCursor, billWhere, decodeCursor, encodeCursor } from "./sales-filter.sql";

export interface BillRow {
  id: string;
  orderId: string;
  billNumber: number;
  tableLabel: string;
  issuedAt: string;
  total: string;
  items: number;
  paymentMode: PaymentMode | null;
  paidAt: string | null;
}

export interface Totals {
  count: number;
  gross: string;
  tax: string;
  serviceCharge: string;
  roundOff: string;
  net: string;
  byMode: Record<PaymentMode | "unpaid", string>;
}

const PAGE = 50;

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businesses: BusinessesService,
  ) {}

  async context(userId: string, businessId: string) {
    const business = await this.businesses.assertOwns(userId, businessId);
    return { business, tz: timezoneFor(business.country) };
  }

  async list(userId: string, businessId: string, filter: SalesFilter, cursor?: string) {
    const { tz } = await this.context(userId, businessId);
    const where = billWhere(filter, businessId, tz);
    const after = cursor ? decodeCursor(cursor) : null;
    if (cursor && !after) throw new BadRequestException("That page link has expired");

    const rows = await this.prisma.db.$queryRaw<
      {
        id: string; order_id: string; bill_number: number; table_label: string; issued_at: Date;
        total: string; items: number; payment_mode: PaymentMode | null; paid_at: Date | null;
      }[]
    >`
      SELECT b.id, b.order_id, b.bill_number, b.table_label, b.issued_at, b.total::text AS total,
             b.payment_mode::text AS payment_mode, b.paid_at,
             COALESCE((SELECT SUM(l.quantity) FROM bill_lines l WHERE l.bill_id = b.id), 0)::int AS items
      FROM bills b
      WHERE ${where} AND ${afterCursor(after)}
      ORDER BY b.issued_at DESC, b.id DESC
      LIMIT ${PAGE + 1}`;

    const page = rows.slice(0, PAGE);
    const last = page[page.length - 1];
    return {
      bills: page.map<BillRow>((r) => ({
        id: r.id,
        orderId: r.order_id,
        billNumber: r.bill_number,
        tableLabel: r.table_label,
        issuedAt: r.issued_at.toISOString(),
        total: r.total,
        items: r.items,
        paymentMode: r.payment_mode,
        paidAt: r.paid_at ? r.paid_at.toISOString() : null,
      })),
      nextCursor: rows.length > PAGE && last ? encodeCursor({ issuedAt: last.issued_at, id: last.id }) : null,
      // Totals for the whole filter, only on the first page — later pages
      // would recompute the same numbers.
      totals: after ? null : await this.totals(where),
    };
  }

  async totals(where: Prisma.Sql): Promise<Totals> {
    const [t] = await this.prisma.db.$queryRaw<
      { count: number; gross: string; tax: string; service: string; round_off: string; net: string;
        cash: string; upi: string; card: string; other: string; unpaid: string }[]
    >`
      SELECT count(*)::int AS count,
             COALESCE(sum(b.total), 0)::text AS gross,
             COALESCE(sum(b.tax_total), 0)::text AS tax,
             COALESCE(sum(b.service_charge), 0)::text AS service,
             COALESCE(sum(b.round_off), 0)::text AS round_off,
             COALESCE(sum(b.total - b.tax_total), 0)::text AS net,
             COALESCE(sum(b.total) FILTER (WHERE b.payment_mode = 'cash'), 0)::text AS cash,
             COALESCE(sum(b.total) FILTER (WHERE b.payment_mode = 'upi'), 0)::text AS upi,
             COALESCE(sum(b.total) FILTER (WHERE b.payment_mode = 'card'), 0)::text AS card,
             COALESCE(sum(b.total) FILTER (WHERE b.payment_mode = 'other'), 0)::text AS other,
             COALESCE(sum(b.total) FILTER (WHERE b.payment_mode IS NULL), 0)::text AS unpaid
      FROM bills b WHERE ${where}`;
    return {
      count: t!.count,
      gross: t!.gross,
      tax: t!.tax,
      serviceCharge: t!.service,
      roundOff: t!.round_off,
      net: t!.net,
      byMode: { cash: t!.cash, upi: t!.upi, card: t!.card, other: t!.other, unpaid: t!.unpaid },
    };
  }

  /**
   * Corrects how a paid bill was settled. Amounts are untouched. The change is
   * logged on the order's timeline, so a correction is visible, not silent.
   */
  async changePaymentMode(userId: string, businessId: string, billId: string, mode: PaymentMode) {
    await this.businesses.assertOwns(userId, businessId);
    const bill = await this.prisma.db.bill.findFirst({
      where: { id: billId, businessId },
      select: { id: true, orderId: true, paymentMode: true, paidAt: true },
    });
    if (!bill) throw new NotFoundException("Bill not found");
    if (!bill.paidAt || !bill.paymentMode) {
      throw new ConflictException("Mark the order paid first");
    }
    if (bill.paymentMode === mode) return { id: bill.id, paymentMode: mode, paidAt: bill.paidAt.toISOString() };

    await this.prisma.db.bill.update({ where: { id: bill.id }, data: { paymentMode: mode } });
    await this.prisma.db.orderEvent.create({
      data: {
        orderId: bill.orderId,
        businessId,
        kind: "payment_mode_changed",
        data: { from: bill.paymentMode, to: mode },
      },
    });
    return { id: bill.id, paymentMode: mode, paidAt: bill.paidAt.toISOString() };
  }
}
```

- [ ] **Step 6: Controller** — `apps/api/src/sales/sales.controller.ts`:

```ts
import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { markPaidSchema, salesFilterSchema, type MarkPaidInput, type SalesFilter } from "@menu/shared";
import type { RequestUser } from "../auth/jwt.strategy";
import { CurrentUser } from "../common/decorators";
import { ZodBody } from "../common/zod.pipe";
import { SalesService } from "./sales.service";

/**
 * The owner's sales record. Authenticated by the global guard; every handler
 * goes through assertOwns in the service, and every query runs on the tenant
 * transaction, so RLS is the second wall.
 */
@Controller("businesses/:bid")
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get("bills")
  list(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Query(new ZodBody(salesFilterSchema)) filter: SalesFilter,
    @Query("cursor") cursor?: string,
  ) {
    return this.sales.list(user.id, bid, filter, cursor);
  }

  @Patch("bills/:billId/payment-mode")
  changeMode(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("billId") billId: string,
    @Body(new ZodBody(markPaidSchema)) body: MarkPaidInput,
  ) {
    return this.sales.changePaymentMode(user.id, bid, billId, body.mode);
  }
}
```

Note: `@Query(pipe)` with no key passes the whole query object through the pipe; Zod strips unknown keys (`cursor`) by default.

- [ ] **Step 7: Remove the old unfiltered route** — in `billing.controller.ts` delete the `@Get("bills") list(...)` handler; in `billing.service.ts` delete `listBills` (no web code calls it — verified by `grep -rn "/bills" apps/web` returning nothing).

- [ ] **Step 8: Register** — in `app.module.ts` import and add `SalesController` to `controllers` and `SalesService` to `providers`.

- [ ] **Step 9: Run tests, typecheck, smoke**

Run: `pnpm --filter @menu/api exec vitest run src/sales && pnpm --filter @menu/api lint`
Expected: PASS.

Smoke (API running via `pnpm dev:api`, a logged-in owner token in `$T` and business id in `$B`):
```bash
curl -s "http://localhost:4000/businesses/$B/bills?from=2026-10-01&to=2026-10-31" -H "Authorization: Bearer $T" | head -c 400
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:4000/businesses/$B/bills?from=2026-10-31&to=2026-10-01" -H "Authorization: Bearer $T"
```
Expected: JSON with `bills`, `nextCursor`, `totals`; second prints `400`.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/sales apps/api/src/app.module.ts apps/api/src/billing
git commit -m "feat(api): filtered sales list with totals, payment mode correction

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Export rows and PDF batches

**Files:**
- Modify: `apps/api/package.json` (add `fflate`)
- Create: `apps/api/src/sales/pdf-batch.ts`
- Create: `apps/api/src/sales/pdf-batch.spec.ts`
- Modify: `apps/api/src/sales/sales.service.ts`, `sales.controller.ts`

**Interfaces:**
- Consumes: `billWhere`, `afterCursor`, `encodeCursor`, `decodeCursor`, `LINE_CATEGORY_JOIN` (Task 4); `shapeBill` (Task 3); `buildBillPdf` (`../billing/bill.pdf`); `MediaService.imageBytes`.
- Produces:
  - `assertAllFound(asked: string[], found: { id: string }[]): void` (throws `NotFoundException`)
  - `zipPdfs(files: { name: string; bytes: Uint8Array }[]): Uint8Array`
  - `billPdfName(billNumber: number): string` → `bill-000123.pdf`
  - `SalesService.exportRows(userId, bid, filter, cursor?): Promise<{ business: ExportBusiness; bills: ExportBill[]; nextCursor: string | null }>`
  - `SalesService.pdfBatch(userId, bid, billIds: string[]): Promise<Uint8Array>`
  - Types `ExportBill`, `ExportLine`, `ExportBusiness` exported from `sales.service.ts` (Web Task 11 mirrors them).
  - Routes `GET businesses/:bid/bills/export/rows`, `POST businesses/:bid/bills/export/pdfs` body `{ billIds: string[] }` (1–25 uuids) → `application/zip`.

- [ ] **Step 1: Add dependency**

Run: `pnpm --filter @menu/api add fflate`

- [ ] **Step 2: Write the failing test** — `apps/api/src/sales/pdf-batch.spec.ts`:

```ts
import { NotFoundException } from "@nestjs/common";
import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { assertAllFound, billPdfName, zipPdfs } from "./pdf-batch";

describe("pdf batch", () => {
  it("names bills with a zero-padded number so they sort", () => {
    expect(billPdfName(7)).toBe("bill-000007.pdf");
    expect(billPdfName(1234567)).toBe("bill-1234567.pdf");
  });

  it("zips files that unzip back to the same bytes", () => {
    const zip = zipPdfs([
      { name: "bill-000001.pdf", bytes: new TextEncoder().encode("%PDF-one") },
      { name: "bill-000002.pdf", bytes: new TextEncoder().encode("%PDF-two") },
    ]);
    const out = unzipSync(zip);
    expect(Object.keys(out).sort()).toEqual(["bill-000001.pdf", "bill-000002.pdf"]);
    expect(strFromU8(out["bill-000002.pdf"]!)).toBe("%PDF-two");
  });

  it("refuses the whole batch if any id was not found", () => {
    expect(() => assertAllFound(["a", "b"], [{ id: "a" }])).toThrow(NotFoundException);
    expect(() => assertAllFound(["a", "a"], [{ id: "a" }])).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @menu/api exec vitest run src/sales/pdf-batch.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** — `apps/api/src/sales/pdf-batch.ts`:

```ts
import { NotFoundException } from "@nestjs/common";
import { zipSync } from "fflate";

export function billPdfName(billNumber: number): string {
  return `bill-${String(billNumber).padStart(6, "0")}.pdf`;
}

/**
 * All or nothing. A batch that silently dropped an id would produce an
 * export missing a bill, and nobody would notice until the books disagreed.
 */
export function assertAllFound(asked: string[], found: { id: string }[]): void {
  const have = new Set(found.map((f) => f.id));
  if (!asked.every((id) => have.has(id))) throw new NotFoundException("Bill not found");
}

/** Store-only: PDFs are already compressed, so deflating again is wasted CPU. */
export function zipPdfs(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  return zipSync(Object.fromEntries(files.map((f) => [f.name, [f.bytes, { level: 0 }]])));
}
```

- [ ] **Step 5: Service methods** — add to `SalesService` (constructor gains `private readonly media: MediaService`; imports `LINE_CATEGORY_JOIN` from `./sales-filter.sql`, `shapeBill` from `../billing/billing.service`, `buildBillPdf` from `../billing/bill.pdf`, `MediaService` from `../media/media.service`, `assertAllFound, billPdfName, zipPdfs` from `./pdf-batch`):

```ts
export interface ExportLine {
  name: string;
  variant: string | null;
  category: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  lineNet: string;
  taxRate: string;
  taxAmount: string;
}

export interface ExportBill {
  id: string;
  billNumber: number;
  issuedAt: string;
  tableLabel: string;
  paymentMode: PaymentMode | null;
  paidAt: string | null;
  subtotal: string;
  taxTotal: string;
  serviceCharge: string;
  roundOff: string;
  total: string;
  pricesIncludeTax: boolean;
  taxLabel: string;
  gstin: string | null;
  lines: ExportLine[];
}

export interface ExportBusiness {
  name: string;
  timezone: string;
  currency: string;
}

const EXPORT_PAGE = 1000;
```

```ts
  async exportRows(userId: string, businessId: string, filter: SalesFilter, cursor?: string) {
    const { tz, business } = await this.context(userId, businessId);
    const after = cursor ? decodeCursor(cursor) : null;
    if (cursor && !after) throw new BadRequestException("That page link has expired");
    const where = billWhere(filter, businessId, tz);

    // Oldest first: a register reads forwards in time.
    const bills = await this.prisma.db.$queryRaw<
      {
        id: string; bill_number: number; issued_at: Date; table_label: string;
        payment_mode: PaymentMode | null; paid_at: Date | null; subtotal: string; tax_total: string;
        service_charge: string; round_off: string; total: string; prices_include_tax: boolean;
        tax_label: string; gstin: string | null;
      }[]
    >`
      SELECT b.id, b.bill_number, b.issued_at, b.table_label, b.payment_mode::text AS payment_mode, b.paid_at,
             b.subtotal::text AS subtotal, b.tax_total::text AS tax_total, b.service_charge::text AS service_charge,
             b.round_off::text AS round_off, b.total::text AS total, b.prices_include_tax, b.tax_label,
             b.business_snapshot->>'gstin' AS gstin
      FROM bills b
      WHERE ${where}
        AND ${after ? Prisma.sql`(b.issued_at, b.id) > (${after.issuedAt}::timestamptz, ${after.id}::uuid)` : Prisma.sql`TRUE`}
      ORDER BY b.issued_at ASC, b.id ASC
      LIMIT ${EXPORT_PAGE + 1}`;

    const page = bills.slice(0, EXPORT_PAGE);
    const ids = page.map((b) => b.id);
    const lines = ids.length
      ? await this.prisma.db.$queryRaw<
          { bill_id: string; name: string; variant: string | null; category: string | null; deleted: boolean;
            quantity: number; unit_price: string; line_total: string; line_net: string; tax_rate: string; tax_amount: string }[]
        >`
          SELECT l.bill_id, l.name, l.variant, cat.category_name AS category, (cat.menu_item_id IS NULL) AS deleted,
                 l.quantity, l.unit_price::text AS unit_price, l.line_total::text AS line_total,
                 l.line_net::text AS line_net, l.tax_rate::text AS tax_rate, l.tax_amount::text AS tax_amount
          FROM bill_lines l
          JOIN bills b ON b.id = l.bill_id
          ${LINE_CATEGORY_JOIN}
          WHERE l.bill_id = ANY(${ids}::uuid[])
          ORDER BY l.bill_id, l.position`
      : [];

    const byBill = new Map<string, ExportLine[]>();
    for (const l of lines) {
      const list = byBill.get(l.bill_id) ?? [];
      list.push({
        name: l.name,
        variant: l.variant,
        category: l.category ?? (l.deleted ? "Deleted item" : "Uncategorised"),
        quantity: l.quantity,
        unitPrice: l.unit_price,
        lineTotal: l.line_total,
        lineNet: l.line_net,
        taxRate: l.tax_rate,
        taxAmount: l.tax_amount,
      });
      byBill.set(l.bill_id, list);
    }

    const last = page[page.length - 1];
    return {
      business: { name: business.name, timezone: tz, currency: business.currency } satisfies ExportBusiness,
      bills: page.map<ExportBill>((b) => ({
        id: b.id,
        billNumber: b.bill_number,
        issuedAt: b.issued_at.toISOString(),
        tableLabel: b.table_label,
        paymentMode: b.payment_mode,
        paidAt: b.paid_at ? b.paid_at.toISOString() : null,
        subtotal: b.subtotal,
        taxTotal: b.tax_total,
        serviceCharge: b.service_charge,
        roundOff: b.round_off,
        total: b.total,
        pricesIncludeTax: b.prices_include_tax,
        taxLabel: b.tax_label,
        gstin: b.gstin,
        lines: byBill.get(b.id) ?? [],
      })),
      nextCursor: bills.length > EXPORT_PAGE && last ? encodeCursor({ issuedAt: last.issued_at, id: last.id }) : null,
    };
  }

  async pdfBatch(userId: string, businessId: string, billIds: string[]): Promise<Uint8Array> {
    await this.businesses.assertOwns(userId, businessId);
    const bills = await this.prisma.db.bill.findMany({
      where: { id: { in: billIds }, businessId },
      include: { lines: { orderBy: { position: "asc" } } },
      orderBy: { billNumber: "asc" },
    });
    assertAllFound(billIds, bills);

    // A logo changes rarely; fetch each distinct one once per batch.
    const logos = new Map<string | null, Promise<Buffer | null>>();
    const files: { name: string; bytes: Uint8Array }[] = [];
    for (const raw of bills) {
      const bill = shapeBill(raw);
      const path = bill.business.logoPath ?? null;
      if (!logos.has(path)) logos.set(path, this.media.imageBytes(path));
      const pdf = await buildBillPdf(bill, await logos.get(path)!);
      files.push({ name: billPdfName(bill.billNumber), bytes: new Uint8Array(pdf) });
    }
    return zipPdfs(files);
  }
```

- [ ] **Step 6: Routes** — in `SalesController` (imports: `Post, Res` from `@nestjs/common`, `type { Response } from "express"`, `z` from `zod`):

```ts
const pdfBatchSchema = z.object({ billIds: z.array(z.string().uuid()).min(1).max(25) });
```

```ts
  @Get("bills/export/rows")
  exportRows(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Query(new ZodBody(salesFilterSchema)) filter: SalesFilter,
    @Query("cursor") cursor?: string,
  ) {
    return this.sales.exportRows(user.id, bid, filter, cursor);
  }

  @Post("bills/export/pdfs")
  async pdfs(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Body(new ZodBody(pdfBatchSchema)) body: z.infer<typeof pdfBatchSchema>,
    @Res() res: Response,
  ) {
    const zip = await this.sales.pdfBatch(user.id, bid, body.billIds);
    res.setHeader("Content-Type", "application/zip");
    res.send(Buffer.from(zip));
  }
```

Declare `bills/export/rows` **before** any `bills/:billId` GET route if one is added later (Nest matches in declaration order).

- [ ] **Step 7: Run tests, typecheck, smoke**

Run: `pnpm --filter @menu/api exec vitest run src/sales && pnpm --filter @menu/api lint`
Expected: PASS.

Smoke:
```bash
curl -s "http://localhost:4000/businesses/$B/bills/export/rows?from=2026-10-01&to=2026-10-31" -H "Authorization: Bearer $T" | head -c 600
ID=$(curl -s "http://localhost:4000/businesses/$B/bills/export/rows?from=2026-10-01&to=2026-10-31" -H "Authorization: Bearer $T" | python3 -c "import sys,json;print(json.load(sys.stdin)['bills'][0]['id'])")
curl -s -X POST "http://localhost:4000/businesses/$B/bills/export/pdfs" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d "{\"billIds\":[\"$ID\"]}" -o /tmp/b.zip && unzip -l /tmp/b.zip
```
Expected: rows JSON with `lines[].category`; the zip lists one `bill-NNNNNN.pdf`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/sales
git commit -m "feat(api): export rows and bill PDF batches for the sales ZIP

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Analytics

**Files:**
- Create: `apps/api/src/sales/series.ts`
- Create: `apps/api/src/sales/series.spec.ts`
- Create: `apps/api/src/sales/analytics.service.ts`
- Modify: `apps/api/src/sales/sales.controller.ts`, `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `billWhere`, `lineMatch`, `LINE_CATEGORY_JOIN` (Task 4); `SalesService.totals`, `SalesService.context` (Task 4); `bucketFor`, `previousPeriod`, `addDays` (Task 1).
- Produces:
  - `fillSeries(points: { start: string; gross: string; bills: number }[], range: DateRange, bucket): { start: string; gross: string; bills: number }[]`
  - `AnalyticsService.get(userId, bid, filter): Promise<Analytics>`; type `Analytics` exported:
    ```ts
    {
      range: DateRange; previous: DateRange; timezone: string; currency: string;
      kpis: { current: Kpis; previous: Kpis };
      series: { bucket: "day" | "week" | "month"; points: { start: string; gross: string; bills: number }[] };
      items: { name: string; variant: string | null; category: string; qty: number; gross: string }[];
      categories: { category: string; qty: number; gross: string }[];
      heatmap: { dow: number; hour: number; bills: number; gross: string }[]; // dow 1=Mon..7=Sun
      tables: { label: string; bills: number; gross: string }[];
      kitchen: { toAccept: number | null; toReady: number | null; toServe: number | null; toPay: number | null; orders: number };
      cancellations: { units: number; value: string; byReason: { reason: string; units: number }[] };
      ratings: { average: number | null; count: number; distribution: number[] }; // index 0 = 1 star
    }
    type Kpis = Totals & { avgBill: string; itemsSold: number };
    ```
  - Route `GET businesses/:bid/analytics?<filter>`.

- [ ] **Step 1: Write the failing test** — `apps/api/src/sales/series.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fillSeries } from "./series";

describe("fillSeries", () => {
  it("fills missing days with zeros, in order", () => {
    const out = fillSeries(
      [{ start: "2026-10-03", gross: "300.00", bills: 2 }],
      { from: "2026-10-01", to: "2026-10-03" },
      "day",
    );
    expect(out).toEqual([
      { start: "2026-10-01", gross: "0", bills: 0 },
      { start: "2026-10-02", gross: "0", bills: 0 },
      { start: "2026-10-03", gross: "300.00", bills: 2 },
    ]);
  });

  it("starts weeks on the Monday on or before `from`", () => {
    const out = fillSeries([], { from: "2026-10-01", to: "2026-10-14" }, "week");
    expect(out.map((p) => p.start)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]);
  });

  it("walks months by calendar month", () => {
    const out = fillSeries([], { from: "2026-01-15", to: "2026-03-02" }, "month");
    expect(out.map((p) => p.start)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @menu/api exec vitest run src/sales/series.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `apps/api/src/sales/series.ts`:

```ts
import { addDays, type DateRange } from "@menu/shared";

type Point = { start: string; gross: string; bills: number };

function bucketStart(date: string, bucket: "day" | "week" | "month"): string {
  if (bucket === "day") return date;
  if (bucket === "month") return `${date.slice(0, 7)}-01`;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}

function nextStart(start: string, bucket: "day" | "week" | "month"): string {
  if (bucket === "day") return addDays(start, 1);
  if (bucket === "week") return addDays(start, 7);
  const [y, m] = start.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/** A chart with gaps reads as "no data"; a zero reads as "no sales". */
export function fillSeries(points: Point[], range: DateRange, bucket: "day" | "week" | "month"): Point[] {
  const have = new Map(points.map((p) => [p.start, p]));
  const out: Point[] = [];
  for (let s = bucketStart(range.from, bucket); s <= range.to; s = nextStart(s, bucket)) {
    out.push(have.get(s) ?? { start: s, gross: "0", bills: 0 });
  }
  return out;
}
```

Run: `pnpm --filter @menu/api exec vitest run src/sales/series.spec.ts` — Expected: PASS.

- [ ] **Step 4: Service** — `apps/api/src/sales/analytics.service.ts`:

```ts
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { addDays, bucketFor, previousPeriod, type DateRange, type SalesFilter } from "@menu/shared";
import { PrismaService } from "../prisma/prisma.service";
import { LINE_CATEGORY_JOIN, billWhere, lineMatch } from "./sales-filter.sql";
import { SalesService, type Totals } from "./sales.service";
import { fillSeries } from "./series";

export type Kpis = Totals & { avgBill: string; itemsSold: number };

/**
 * Every section is one aggregate query over the same filtered bills. They run
 * one after another on the request's tenant transaction (a transaction is a
 * single connection), which with a remote database is ~10 round trips —
 * comfortably inside the 20 s transaction ceiling.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sales: SalesService,
  ) {}

  async get(userId: string, businessId: string, filter: SalesFilter) {
    const { tz, business } = await this.sales.context(userId, businessId);
    const range: DateRange = { from: filter.from, to: filter.to };
    const previous = previousPeriod(range);
    const where = billWhere(filter, businessId, tz);
    const prevWhere = billWhere({ ...filter, ...previous }, businessId, tz);
    const bucket = bucketFor(range);
    const db = this.prisma.db;

    const kpis = { current: await this.kpis(where), previous: await this.kpis(prevWhere) };

    const seriesRows = await db.$queryRaw<{ start: string; gross: string; bills: number }[]>`
      SELECT to_char(date_trunc(${bucket}, b.issued_at AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS start,
             sum(b.total)::text AS gross, count(*)::int AS bills
      FROM bills b WHERE ${where} GROUP BY 1 ORDER BY 1`;

    const items = await db.$queryRaw<{ name: string; variant: string | null; category: string; qty: number; gross: string }[]>`
      SELECT l.name, l.variant,
             COALESCE(cat.category_name, CASE WHEN cat.menu_item_id IS NULL THEN 'Deleted item' ELSE 'Uncategorised' END) AS category,
             sum(l.quantity)::int AS qty, sum(l.line_total)::text AS gross
      FROM bills b JOIN bill_lines l ON l.bill_id = b.id
      ${LINE_CATEGORY_JOIN}
      WHERE ${where} AND ${lineMatch(filter)}
      GROUP BY 1, 2, 3 ORDER BY sum(l.line_total) DESC LIMIT 200`;

    const categories = await db.$queryRaw<{ category: string; qty: number; gross: string }[]>`
      SELECT COALESCE(cat.category_name, CASE WHEN cat.menu_item_id IS NULL THEN 'Deleted item' ELSE 'Uncategorised' END) AS category,
             sum(l.quantity)::int AS qty, sum(l.line_total)::text AS gross
      FROM bills b JOIN bill_lines l ON l.bill_id = b.id
      ${LINE_CATEGORY_JOIN}
      WHERE ${where} AND ${lineMatch(filter)}
      GROUP BY 1 ORDER BY sum(l.line_total) DESC`;

    const heatmap = await db.$queryRaw<{ dow: number; hour: number; bills: number; gross: string }[]>`
      SELECT extract(isodow FROM b.issued_at AT TIME ZONE ${tz})::int AS dow,
             extract(hour FROM b.issued_at AT TIME ZONE ${tz})::int AS hour,
             count(*)::int AS bills, sum(b.total)::text AS gross
      FROM bills b WHERE ${where} GROUP BY 1, 2`;

    const tables = await db.$queryRaw<{ label: string; bills: number; gross: string }[]>`
      SELECT b.table_label AS label, count(*)::int AS bills, sum(b.total)::text AS gross
      FROM bills b WHERE ${where} GROUP BY 1 ORDER BY sum(b.total) DESC`;

    // First time each stage was reached. A second round resets an order to
    // 'placed'; using the first occurrence measures the first round, which is
    // what "how long did the kitchen take" means to an owner.
    const [kitchen] = await db.$queryRaw<
      { to_accept: number | null; to_ready: number | null; to_serve: number | null; to_pay: number | null; orders: number }[]
    >`
      WITH fb AS (SELECT b.order_id FROM bills b WHERE ${where}),
      st AS (
        SELECT e.order_id,
               min(e.at) FILTER (WHERE e.kind = 'placed')    AS placed,
               min(e.at) FILTER (WHERE e.kind = 'accepted')  AS accepted,
               min(e.at) FILTER (WHERE e.kind = 'ready')     AS ready,
               min(e.at) FILTER (WHERE e.kind = 'completed') AS completed,
               min(e.at) FILTER (WHERE e.kind = 'paid')      AS paid
        FROM order_events e JOIN fb ON fb.order_id = e.order_id
        GROUP BY e.order_id
      )
      SELECT
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM accepted - placed)) / 60)::numeric, 1)::float AS to_accept,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ready - COALESCE(accepted, placed))) / 60)::numeric, 1)::float AS to_ready,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed - ready)) / 60)::numeric, 1)::float AS to_serve,
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM paid - completed)) / 60)::numeric, 1)::float AS to_pay,
        count(*)::int AS orders
      FROM st`;

    // Date range only: a cancelled line never reached a bill, so payment,
    // table-on-bill, total and bill-number filters have nothing to match.
    const cancelRows = await db.$queryRaw<{ reason: string; units: number; value: string }[]>`
      SELECT c.reason::text AS reason, sum(c.quantity)::int AS units, sum(c.quantity * c.unit_price)::text AS value
      FROM order_item_cancellations c
      WHERE c.business_id = ${businessId}::uuid
        AND c.created_at >= (${filter.from}::date::timestamp AT TIME ZONE ${tz})
        AND c.created_at <  (${addDays(filter.to, 1)}::date::timestamp AT TIME ZONE ${tz})
      GROUP BY 1 ORDER BY 2 DESC`;

    const ratingRows = await db.$queryRaw<{ stars: number; n: number }[]>`
      SELECT r.stars, count(*)::int AS n
      FROM order_ratings r JOIN bills b ON b.order_id = r.order_id
      WHERE ${where} GROUP BY 1`;

    const distribution = [1, 2, 3, 4, 5].map((s) => ratingRows.find((r) => r.stars === s)?.n ?? 0);
    const ratingCount = distribution.reduce((a, b) => a + b, 0);

    return {
      range,
      previous,
      timezone: tz,
      currency: business.currency,
      kpis,
      series: { bucket, points: fillSeries(seriesRows, range, bucket) },
      items,
      categories,
      heatmap,
      tables,
      kitchen: {
        toAccept: kitchen?.to_accept ?? null,
        toReady: kitchen?.to_ready ?? null,
        toServe: kitchen?.to_serve ?? null,
        toPay: kitchen?.to_pay ?? null,
        orders: kitchen?.orders ?? 0,
      },
      cancellations: {
        units: cancelRows.reduce((a, r) => a + r.units, 0),
        value: cancelRows.reduce((a, r) => a + Number(r.value), 0).toFixed(2),
        byReason: cancelRows.map((r) => ({ reason: r.reason, units: r.units })),
      },
      ratings: {
        average: ratingCount ? Number((distribution.reduce((a, n, i) => a + n * (i + 1), 0) / ratingCount).toFixed(2)) : null,
        count: ratingCount,
        distribution,
      },
    };
  }

  private async kpis(where: Prisma.Sql): Promise<Kpis> {
    const totals = await this.sales.totals(where);
    const [extra] = await this.prisma.db.$queryRaw<{ avg_bill: string; items_sold: number }[]>`
      SELECT COALESCE(avg(b.total), 0)::numeric(12,2)::text AS avg_bill,
             COALESCE((SELECT sum(l.quantity) FROM bill_lines l JOIN bills b2 ON b2.id = l.bill_id
                       WHERE b2.id IN (SELECT b.id FROM bills b WHERE ${where})), 0)::int AS items_sold
      FROM bills b WHERE ${where}`;
    return { ...totals, avgBill: extra!.avg_bill, itemsSold: extra!.items_sold };
  }
}

export type Analytics = Awaited<ReturnType<AnalyticsService["get"]>>;
```

Note on `date_trunc(${bucket}, ...)`: `bucket` is one of three literals produced by `bucketFor`, passed as a bind parameter — valid for `date_trunc(text, timestamp)`.

- [ ] **Step 5: Route + registration** — in `SalesController` constructor add `private readonly analytics: AnalyticsService` and:

```ts
  @Get("analytics")
  insights(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Query(new ZodBody(salesFilterSchema)) filter: SalesFilter,
  ) {
    return this.analytics.get(user.id, bid, filter);
  }
```
Add `AnalyticsService` to `providers` in `app.module.ts`.

- [ ] **Step 6: Run tests, typecheck, smoke**

Run: `pnpm --filter @menu/api exec vitest run src/sales && pnpm --filter @menu/api lint`
Expected: PASS.

Smoke:
```bash
curl -s "http://localhost:4000/businesses/$B/analytics?from=2026-04-01&to=2026-10-31" -H "Authorization: Bearer $T" | python3 -m json.tool | head -60
```
Expected: JSON with every key above; `series.bucket` = `month`; no 500.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/sales apps/api/src/app.module.ts
git commit -m "feat(api): sales analytics over the shared filter

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Isolation and payment-safety probes

**Files:**
- Modify: `apps/api/scripts/check-isolation.sh`

**Interfaces:**
- Consumes: every route from Tasks 3–6.

- [ ] **Step 1: Add probes** — in `check-isolation.sh`, after the `Bills and ratings:` block and before `Platform admin`, insert:

```bash
echo
echo "Sales records, export and insights:"

RANGE="from=2020-01-01&to=2020-12-31"
probe "tenant B lists A's sales"             "$API/businesses/$A_BID/bills?$RANGE" -H "Authorization: Bearer $B_TOKEN"
probe "tenant B reads A's export rows"       "$API/businesses/$A_BID/bills/export/rows?$RANGE" -H "Authorization: Bearer $B_TOKEN"
probe "tenant B reads A's analytics"         "$API/businesses/$A_BID/analytics?$RANGE" -H "Authorization: Bearer $B_TOKEN"
probe "tenant B pulls PDFs from A" -X POST   "$API/businesses/$A_BID/bills/export/pdfs" -H "Authorization: Bearer $B_TOKEN" \
  -H 'Content-Type: application/json' -d '{"billIds":["00000000-0000-0000-0000-000000000000"]}'
probe "tenant B changes a payment mode on A" -X PATCH "$API/businesses/$A_BID/bills/00000000-0000-0000-0000-000000000000/payment-mode" \
  -H "Authorization: Bearer $B_TOKEN" -H 'Content-Type: application/json' -d '{"mode":"cash"}'
probe "table session lists sales"            "$API/businesses/$A_BID/bills?$RANGE" -H "Authorization: Bearer $S1"
probe "table session reads analytics"        "$API/businesses/$A_BID/analytics?$RANGE" -H "Authorization: Bearer $S1"
probe "no token on analytics"                "$API/businesses/$A_BID/analytics?$RANGE"

# A real order on table 1, so the paid-flow checks have something to act on.
CAT=$(curl -s -X POST "$API/businesses/$A_BID/categories" -H "Authorization: Bearer $A_TOKEN"   -H 'Content-Type: application/json' -d '{"name":"Iso","isVisible":true}' | json_field '["id"]')
ITEM=$(curl -s -X POST "$API/businesses/$A_BID/items" -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json'   -d "{\"name\":\"Iso tea\",\"categoryId\":\"$CAT\",\"price\":50,\"isAvailable\":true,\"allergens\":[],\"variants\":[],\"photos\":[]}" | json_field '["id"]')
curl -s -o /dev/null -X POST "$API/public/table/order" -H "Authorization: Bearer $S1"   -H 'Content-Type: application/json' -d "{\"items\":[{\"itemId\":\"$ITEM\",\"quantity\":1}]}"
A_ORDER=$(curl -s "$API/businesses/$A_BID/orders?scope=open" -H "Authorization: Bearer $A_TOKEN"   | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')")

if [ -n "$A_ORDER" ]; then
  # Two Paid taps at once: exactly one may win.
  ( curl -s -o /dev/null -w '%{http_code}' -X POST "$API/businesses/$A_BID/orders/$A_ORDER/paid"       -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' -d '{"mode":"upi"}' > /tmp/iso_s1 ) &
  ( curl -s -o /dev/null -w '%{http_code}' -X POST "$API/businesses/$A_BID/orders/$A_ORDER/paid"       -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' -d '{"mode":"cash"}' > /tmp/iso_s2 ) &
  wait
  OKS=$(cat /tmp/iso_s1 /tmp/iso_s2 | grep -o '2[0-9][0-9]' | wc -l)
  if [ "$OKS" -eq 1 ]; then
    echo "  ok    double Paid tap: exactly one wins"
  else
    echo "  RACE  double Paid tap: $OKS succeeded"
    FAILURES=$((FAILURES + 1))
  fi

  # A's real bill, requested through B's business id: refused whole.
  DAY=$(date -u +%Y-%m-%d)
  A_BILL=$(curl -s "$API/businesses/$A_BID/bills?from=$(date -u -d yesterday +%Y-%m-%d 2>/dev/null || echo $DAY)&to=$(date -u -d tomorrow +%Y-%m-%d 2>/dev/null || echo $DAY)"     -H "Authorization: Bearer $A_TOKEN" | python3 -c "import sys,json;b=json.load(sys.stdin)['bills'];print(b[0]['id'] if b else '')")
  probe "tenant B pulls A's real bill PDF" -X POST "$API/businesses/$B_BID/bills/export/pdfs" -H "Authorization: Bearer $B_TOKEN"     -H 'Content-Type: application/json' -d "{\"billIds\":[\"$A_BILL\"]}"
  probe "owner sets status paid without a mode" -X PATCH "$API/businesses/$A_BID/orders/$A_ORDER/status"     -H "Authorization: Bearer $A_TOKEN" -H 'Content-Type: application/json' -d '{"status":"paid"}'
else
  echo "  skip  paid-flow checks (could not place an order on table 1)"
fi
```

The service-charge-after-payment check needs service charge switched on, so it is asserted in Task 2's SQL (the RAISE) and the e2e in Task 14 rather than here. The local-date window above spans yesterday–tomorrow (UTC) so the check works at any hour in IST.

Also add to the admin block (inside `if [ -n "$ADMIN_TOKEN" ]`):

```bash
  probe "admin reads a business's sales"     "$API/businesses/$A_BID/bills?from=2020-01-01&to=2020-12-31" -H "Authorization: Bearer $ADMIN_TOKEN"
  probe "admin reads a business's analytics" "$API/businesses/$A_BID/analytics?from=2020-01-01&to=2020-12-31" -H "Authorization: Bearer $ADMIN_TOKEN"
```

- [ ] **Step 2: Run it**

Run (API + DB running, `pnpm db:seed` done): `pnpm --filter @menu/api test:isolation`
Expected: every new line `ok`, "double Paid tap: exactly one wins", ends `PASS — no cross-tenant access.`

- [ ] **Step 3: Commit**

```bash
git add apps/api/scripts/check-isolation.sh
git commit -m "test(api): isolation and payment-safety probes for sales routes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Order board "To collect", Paid sheet, diner labels

**Files:**
- Modify: `apps/web/lib/order-timeline.ts`, test `apps/web/lib/order-timeline.spec.ts`
- Modify: `apps/web/components/order/ordering.tsx`
- Create: `apps/web/components/sales/pay-sheet.tsx`
- Modify: `apps/web/app/(app)/orders/page.tsx`

**Interfaces:**
- Consumes: `PAYMENT_MODES`, `PAYMENT_MODE_LABEL`, `PaymentMode`, `formatMoney` from `@menu/shared`; `POST /businesses/:bid/orders/:id/paid`; `GET orders?scope=collect`.
- Produces: `<PaySheet title total currency onPick(mode) onClose busy />` in `components/sales/pay-sheet.tsx` (reused by Task 10).

- [ ] **Step 1: Write the failing test** — append to `apps/web/lib/order-timeline.spec.ts` (match the existing helpers in that file for building events; if it has an `ev(id, kind, at)` helper use it, otherwise inline objects):

```ts
describe("paid", () => {
  const events = [
    { id: 1, kind: "placed", at: "2026-10-03T10:00:00Z" },
    { id: 2, kind: "completed", at: "2026-10-03T10:20:00Z" },
    { id: 3, kind: "paid", at: "2026-10-03T10:25:00Z" },
    { id: 4, kind: "payment_mode_changed", at: "2026-10-03T11:00:00Z", data: null },
  ];

  it("labels paid and ignores mode corrections", () => {
    const steps = buildTimeline(events, { status: "paid", showUpcoming: true });
    expect(steps.map((s) => s.label)).toEqual(["Placed", "Served", "Paid"]);
    expect(steps.at(-1)!.state).toBe("current");
  });

  it("shows Paid as still to come after Served", () => {
    const steps = buildTimeline(events.slice(0, 2), { status: "completed", showUpcoming: true });
    expect(steps.at(-1)).toMatchObject({ label: "Paid", state: "upcoming" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @menu/web exec vitest run lib/order-timeline.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement timeline + diner copy**

In `lib/order-timeline.ts`:
- Add `| "paid"` to `OrderStatus` (after `"completed"`).
- `const FLOW: OrderStatus[] = ["placed", "accepted", "preparing", "ready", "completed", "paid"];`
- `LABELS`: add `paid: "Paid",`.
- Change the finished check to: `if (options.status === "paid" || options.status === "cancelled") return steps;`

In `components/order/ordering.tsx` `STATUS_COPY` add:

```ts
  paid: { label: "Paid", hint: "Thank you — see you again." },
```

Run: `pnpm --filter @menu/web exec vitest run lib/order-timeline.spec.ts` — Expected: PASS (fix any existing test that asserted `completed` was terminal for upcoming steps by expecting a trailing upcoming "Paid").

- [ ] **Step 4: PaySheet** — `apps/web/components/sales/pay-sheet.tsx`:

```tsx
"use client";

import { PAYMENT_MODES, PAYMENT_MODE_LABEL, formatMoney, type PaymentMode } from "@menu/shared";
import { Button, Sheet, SheetGrabber } from "@/components/ui";

/**
 * How was it paid? Four large targets and the amount, nothing else. Nothing
 * is written until a mode is tapped — closing the sheet leaves the order as
 * it was.
 */
export function PaySheet({
  title,
  total,
  currency,
  busy,
  current,
  onPick,
  onClose,
}: {
  title: string;
  total: string | null;
  currency: string;
  busy: boolean;
  /** The mode already recorded, when correcting. */
  current?: PaymentMode | null;
  onPick: (mode: PaymentMode) => void;
  onClose: () => void;
}) {
  return (
    <Sheet label={title} onClose={onClose}>
      <SheetGrabber />
      <div className="px-5 pb-6 pt-4 sm:px-6">
        <h2 className="text-[17px] font-semibold">{title}</h2>
        {total !== null && (
          <p className="tnum mt-1 text-[28px] font-semibold tracking-tight">{formatMoney(total, currency)}</p>
        )}
        <div className="mt-5 grid grid-cols-2 gap-3">
          {PAYMENT_MODES.map((mode) => (
            <Button
              key={mode}
              variant={current === mode ? "primary" : "secondary"}
              className="h-16 text-[16px]"
              disabled={busy}
              onClick={() => onPick(mode)}
            >
              {PAYMENT_MODE_LABEL[mode]}
            </Button>
          ))}
        </div>
        <Button variant="ghost" className="mt-4 w-full" onClick={onClose} disabled={busy}>
          Not now
        </Button>
      </div>
    </Sheet>
  );
}
```

Check `components/ui.tsx` `ButtonProps` for the exact variant names (`primary`/`secondary`/`ghost`) and use the ones that exist.

- [ ] **Step 5: Board changes** — in `app/(app)/orders/page.tsx`:

1. Extend `interface Order` with `bill?: { id: string; total: string; paymentMode: string | null } | null;`.
2. Add state: `const [collect, setCollect] = useState<Order[]>([]);` and `const [paying, setPaying] = useState<Order | null>(null);`
3. In `load`, fetch the third scope in the same `Promise.all`:
   ```ts
   const [open, today, toCollect] = await Promise.all([
     api.get<Order[]>(`/businesses/${current.id}/orders?scope=open`),
     api.get<Order[]>(`/businesses/${current.id}/orders?scope=today`),
     api.get<Order[]>(`/businesses/${current.id}/orders?scope=collect`),
   ]);
   if (!fresh.current.accepts(token)) return;
   setOrders(open);
   setCollect(toCollect);
   setPast(
     today
       .filter((o) => o.status === "paid" || o.status === "cancelled" || o.status === "completed")
       .sort((a, b) => b.dailyNumber - a.dailyNumber),
   );
   ```
4. Add the mark-paid action next to `advance`:
   ```ts
   async function markPaid(order: Order, mode: PaymentMode) {
     if (!current) return;
     setBusy(order.id);
     const written = fresh.current.mutating();
     try {
       await api.post(`/businesses/${current.id}/orders/${order.id}/paid`, { mode });
       setCollect((prev) => prev.filter((o) => o.id !== order.id));
       setOrders((prev) => prev.filter((o) => o.id !== order.id));
       setPaying(null);
     } catch (err) {
       // 409 = someone else got there first; the reload shows the truth.
       setPaying(null);
     } finally {
       written();
       setBusy(null);
       void load();
     }
   }
   ```
5. Render a **To collect** column after the Ready column, using the same column/card markup the four `COLUMNS` use. The phone lane `Segmented` gains an option `{ value: "collect", label: "To collect", badge: collect.length }`; widen the `lane` state type to `Status | "collect"`. Each card in the column shows table label, daily number, `formatMoney(order.bill?.total ?? "0", current.currency)`, and a primary **Paid** button: `onClick={() => setPaying(order)}`.
6. On cards in the four open columns, add a secondary **Paid** action next to the existing advance button (counter service): `onClick={() => setPaying(order)}`.
7. In history rows, for `status === "completed"` show a **Mark paid** button (`setPaying(order)`); for `paid` show the mode pill using `PAYMENT_MODE_LABEL[order.bill.paymentMode]`.
8. At the end of the page JSX:
   ```tsx
   {paying && (
     <PaySheet
       title={`Table ${paying.table.label} · #${paying.dailyNumber}`}
       total={paying.bill?.total ?? null}
       currency={current.currency}
       busy={busy === paying.id}
       onPick={(mode) => void markPaid(paying, mode)}
       onClose={() => setPaying(null)}
     />
   )}
   ```
   (Import `PaySheet` and `type PaymentMode`.)

- [ ] **Step 6: Typecheck + manual run**

Run: `pnpm --filter @menu/web lint && pnpm --filter @menu/web exec vitest run`
Expected: PASS.

Manual (`pnpm dev`): place an order from a table, Accept → Ready → Served. It appears in **To collect** with the bill total. Tap Paid → UPI. It leaves the column; history shows "UPI". Place another order and tap Paid directly from New → it goes straight to history as paid.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/order-timeline.ts apps/web/lib/order-timeline.spec.ts apps/web/components/order/ordering.tsx apps/web/components/sales/pay-sheet.tsx "apps/web/app/(app)/orders/page.tsx"
git commit -m "feat(web): To collect column and Paid with a payment mode

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Shared web plumbing — types, URL filter state, filter bar

**Files:**
- Create: `apps/web/lib/sales/types.ts`
- Create: `apps/web/components/sales/use-sales-filter.ts`
- Create: `apps/web/components/sales/use-sales-filter.spec.ts`
- Create: `apps/web/components/sales/filter-bar.tsx`
- Modify: `apps/web/lib/api-client.ts` (add `apiBinary`)

**Interfaces:**
- Consumes: Task 1 exports; API response shapes from Tasks 4–6.
- Produces:
  - `lib/sales/types.ts`: `BillRow`, `Totals`, `ExportBill`, `ExportLine`, `ExportBusiness`, `Analytics` (copied field-for-field from the API interfaces in Tasks 4–6).
  - `filterFromSearch(search: URLSearchParams, tz: string, now?: Date): { filter: SalesFilter; preset: PeriodPreset | "custom" }` — defaults to `this_month` when `from`/`to` are absent or invalid.
  - `useSalesFilter(tz): { filter, preset, setFilter(next: SalesFilter, preset?: PeriodPreset | "custom"): void, query: string }` — reads/writes the URL via `useSearchParams` + `router.replace`; `query` is `salesFilterToParams(filter).toString()`. The preset is stored as `p=<preset>` in the URL alongside the filter.
  - `<FilterBar tz filter preset onChange tables categories items />` where `tables: string[]`, `categories: {id,name}[]`, `items: {id,name,categoryId}[]`.
  - `apiBinary(path: string, body: unknown): Promise<Uint8Array>` in `lib/api-client.ts`.

- [ ] **Step 1: Write the failing test** — `apps/web/components/sales/use-sales-filter.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { filterFromSearch } from "./use-sales-filter";

const now = new Date("2026-10-03T06:00:00Z");

describe("filterFromSearch", () => {
  it("defaults to this month in the business timezone", () => {
    const r = filterFromSearch(new URLSearchParams(), "Asia/Kolkata", now);
    expect(r.preset).toBe("this_month");
    expect(r.filter).toMatchObject({ from: "2026-10-01", to: "2026-10-03" });
  });

  it("recomputes a preset from today rather than trusting stale dates", () => {
    const r = filterFromSearch(new URLSearchParams("p=yesterday&from=2026-01-01&to=2026-01-01"), "Asia/Kolkata", now);
    expect(r.filter).toMatchObject({ from: "2026-10-02", to: "2026-10-02" });
  });

  it("keeps custom dates and the other filters", () => {
    const r = filterFromSearch(
      new URLSearchParams("p=custom&from=2026-09-01&to=2026-09-15&modes=cash&modes=unpaid&tables=12"),
      "Asia/Kolkata",
      now,
    );
    expect(r.preset).toBe("custom");
    expect(r.filter).toMatchObject({ from: "2026-09-01", to: "2026-09-15", modes: ["cash", "unpaid"], tables: ["12"] });
  });

  it("falls back to the default on an invalid range instead of crashing", () => {
    const r = filterFromSearch(new URLSearchParams("p=custom&from=2026-09-30&to=2026-09-01"), "UTC", now);
    expect(r.preset).toBe("this_month");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @menu/web exec vitest run components/sales/use-sales-filter.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `apps/web/components/sales/use-sales-filter.ts`:

```ts
"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  PERIOD_PRESETS,
  localToday,
  paramsToObject,
  presetRange,
  salesFilterSchema,
  salesFilterToParams,
  type PeriodPreset,
  type SalesFilter,
} from "@menu/shared";

export type PresetOrCustom = PeriodPreset | "custom";

function isPreset(v: string | null): v is PeriodPreset {
  return v !== null && (PERIOD_PRESETS as readonly string[]).includes(v);
}

/**
 * The URL is the state. A filtered view survives refresh, can be bookmarked,
 * and is what an owner sends their accountant (who logs in as them).
 *
 * A preset is re-evaluated against today, so a bookmarked "This month" is
 * always this month, not the month it was saved in.
 */
export function filterFromSearch(
  search: URLSearchParams,
  tz: string,
  now: Date = new Date(),
): { filter: SalesFilter; preset: PresetOrCustom } {
  const today = localToday(tz, now);
  const p = search.get("p");
  const obj: Record<string, unknown> = paramsToObject(search);
  delete obj.p;
  if (isPreset(p)) Object.assign(obj, presetRange(p, today));
  const parsed = salesFilterSchema.safeParse(obj);
  if (parsed.success) return { filter: parsed.data, preset: isPreset(p) ? p : "custom" };
  return { filter: { ...presetRange("this_month", today) } as SalesFilter, preset: "this_month" };
}

export function useSalesFilter(tz: string) {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const { filter, preset } = useMemo(
    () => filterFromSearch(new URLSearchParams(search.toString()), tz),
    [search, tz],
  );

  const setFilter = useCallback(
    (next: SalesFilter, nextPreset: PresetOrCustom = "custom") => {
      const params = salesFilterToParams(next);
      params.set("p", nextPreset);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname],
  );

  const query = useMemo(() => salesFilterToParams(filter).toString(), [filter]);
  return { filter, preset, setFilter, query };
}
```

Run: `pnpm --filter @menu/web exec vitest run components/sales/use-sales-filter.spec.ts` — Expected: PASS.

- [ ] **Step 4: Types** — `apps/web/lib/sales/types.ts`: copy `BillRow`, `Totals` (Task 4), `ExportLine`, `ExportBill`, `ExportBusiness` (Task 5), and the `Analytics` shape from Task 6's Interfaces block as plain TS interfaces (strings for money, `PaymentMode | null` for modes, importing `PaymentMode`, `DateRange` from `@menu/shared`). Add:

```ts
export interface SalesPage {
  bills: BillRow[];
  nextCursor: string | null;
  totals: Totals | null;
}

export interface ExportPage {
  business: ExportBusiness;
  bills: ExportBill[];
  nextCursor: string | null;
}
```

- [ ] **Step 5: `apiBinary`** — in `lib/api-client.ts` after `downloadFile`:

```ts
/**
 * POSTs JSON and returns the raw bytes — the sales export's PDF batches.
 * One refresh-and-retry on 401, like every other call: an export of a year
 * of bills outlives a 15-minute access token.
 */
export async function apiBinary(path: string, body: unknown): Promise<Uint8Array> {
  const send = () =>
    fetchWithDeadline(`${API}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
      credentials: "include",
    });
  let res = await send();
  if (res.status === 401 && (await restoreSession())) res = await send();
  if (!res.ok) throw new ApiError(res.status, "Could not fetch the bill PDFs");
  return new Uint8Array(await res.arrayBuffer());
}
```

- [ ] **Step 6: FilterBar** — `apps/web/components/sales/filter-bar.tsx`. Requirements (implement with the existing `Segmented`, `Sheet`, `SheetGrabber`, `Field`, `Input`, `Select`, `Button`, `cx` from `@/components/ui`):

```tsx
"use client";

import { useState } from "react";
import {
  PAYMENT_FILTERS,
  PAYMENT_MODE_LABEL,
  PERIOD_PRESETS,
  PERIOD_PRESET_LABEL,
  localToday,
  presetRange,
  salesFilterSchema,
  type PaymentFilter,
  type SalesFilter,
} from "@menu/shared";
import { Button, Field, Input, Select, Sheet, SheetGrabber, cx } from "@/components/ui";
import type { PresetOrCustom } from "./use-sales-filter";

const MODE_LABEL: Record<PaymentFilter, string> = { ...PAYMENT_MODE_LABEL, unpaid: "Unpaid" };

export function FilterBar({
  tz,
  filter,
  preset,
  onChange,
  tables,
  categories,
  items,
}: {
  tz: string;
  filter: SalesFilter;
  preset: PresetOrCustom;
  onChange: (next: SalesFilter, preset: PresetOrCustom) => void;
  tables: string[];
  categories: { id: string; name: string }[];
  items: { id: string; name: string; categoryId: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SalesFilter>(filter);
  const [error, setError] = useState<string | null>(null);

  function pickPreset(p: PresetOrCustom) {
    if (p === "custom") {
      setDraft(filter);
      setOpen(true);
      return;
    }
    onChange({ ...filter, ...presetRange(p, localToday(tz)) }, p);
  }

  function apply() {
    const parsed = salesFilterSchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the filters");
      return;
    }
    const datesChanged = parsed.data.from !== filter.from || parsed.data.to !== filter.to;
    onChange(parsed.data, datesChanged ? "custom" : preset);
    setOpen(false);
  }

  function toggle<K extends "modes" | "tables">(key: K, value: string) {
    const list = new Set((draft[key] as string[] | undefined) ?? []);
    list.has(value) ? list.delete(value) : list.add(value);
    setDraft({ ...draft, [key]: list.size ? [...list] : undefined });
  }

  const chips: { label: string; clear: () => void }[] = [
    ...(filter.modes ?? []).map((m) => ({
      label: MODE_LABEL[m],
      clear: () => onChange({ ...filter, modes: filter.modes!.filter((x) => x !== m) }, preset),
    })),
    ...(filter.tables ?? []).map((t) => ({
      label: `Table ${t}`,
      clear: () => onChange({ ...filter, tables: filter.tables!.filter((x) => x !== t) }, preset),
    })),
    ...(filter.categoryId
      ? [{ label: categories.find((c) => c.id === filter.categoryId)?.name ?? "Category", clear: () => onChange({ ...filter, categoryId: undefined }, preset) }]
      : []),
    ...(filter.menuItemId
      ? [{ label: items.find((i) => i.id === filter.menuItemId)?.name ?? "Dish", clear: () => onChange({ ...filter, menuItemId: undefined }, preset) }]
      : []),
    ...(filter.minTotal !== undefined || filter.maxTotal !== undefined
      ? [{ label: `Total ${filter.minTotal ?? 0}–${filter.maxTotal ?? "∞"}`, clear: () => onChange({ ...filter, minTotal: undefined, maxTotal: undefined }, preset) }]
      : []),
    ...(filter.billNo !== undefined
      ? [{ label: `Bill #${filter.billNo}`, clear: () => onChange({ ...filter, billNo: undefined }, preset) }]
      : []),
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="flex gap-1.5">
            {[...PERIOD_PRESETS, "custom" as const].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => pickPreset(p)}
                aria-pressed={preset === p}
                className={cx(
                  "spring h-9 shrink-0 rounded-lg px-3 text-[13.5px] font-medium",
                  preset === p ? "bg-ink text-surface" : "bg-[var(--raised)] text-muted hover:text-ink",
                )}
              >
                {p === "custom" ? "Custom" : PERIOD_PRESET_LABEL[p]}
              </button>
            ))}
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { setDraft(filter); setOpen(true); }}>
          More filters
        </Button>
      </div>

      <p className="tnum text-[13px] text-muted">
        {filter.from === filter.to ? filter.from : `${filter.from} → ${filter.to}`}
      </p>

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button key={c.label} type="button" onClick={c.clear}
              className="rounded-full border border-line px-2.5 py-1 text-[12.5px] hover:border-ink">
              {c.label} <span aria-hidden="true">×</span>
              <span className="sr-only">Remove filter</span>
            </button>
          ))}
          <button type="button" className="px-2 text-[12.5px] text-muted underline"
            onClick={() => onChange({ from: filter.from, to: filter.to }, preset)}>
            Clear all
          </button>
        </div>
      )}

      {open && (
        <Sheet label="Filters" onClose={() => setOpen(false)} side="side">
          <SheetGrabber />
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="From">
                <Input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
              </Field>
              <Field label="To">
                <Input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
              </Field>
            </div>

            <fieldset>
              <legend className="mb-2 text-[13px] font-medium">Payment</legend>
              <div className="flex flex-wrap gap-1.5">
                {PAYMENT_FILTERS.map((m) => (
                  <button key={m} type="button" onClick={() => toggle("modes", m)}
                    aria-pressed={draft.modes?.includes(m) ?? false}
                    className={cx("rounded-lg px-3 py-1.5 text-[13px]",
                      draft.modes?.includes(m) ? "bg-ink text-surface" : "bg-[var(--raised)]")}>
                    {MODE_LABEL[m]}
                  </button>
                ))}
              </div>
            </fieldset>

            {tables.length > 0 && (
              <fieldset>
                <legend className="mb-2 text-[13px] font-medium">Tables</legend>
                <div className="flex flex-wrap gap-1.5">
                  {tables.map((t) => (
                    <button key={t} type="button" onClick={() => toggle("tables", t)}
                      aria-pressed={draft.tables?.includes(t) ?? false}
                      className={cx("rounded-lg px-3 py-1.5 text-[13px]",
                        draft.tables?.includes(t) ? "bg-ink text-surface" : "bg-[var(--raised)]")}>
                      {t}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}

            <Field label="Category">
              <Select value={draft.categoryId ?? ""} onChange={(e) => setDraft({ ...draft, categoryId: e.target.value || undefined, menuItemId: undefined })}>
                <option value="">All categories</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Dish">
              <Select value={draft.menuItemId ?? ""} onChange={(e) => setDraft({ ...draft, menuItemId: e.target.value || undefined })}>
                <option value="">All dishes</option>
                {items.filter((i) => !draft.categoryId || i.categoryId === draft.categoryId)
                  .map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </Select>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Min total">
                <Input inputMode="decimal" value={draft.minTotal ?? ""} onChange={(e) => setDraft({ ...draft, minTotal: e.target.value === "" ? undefined : Number(e.target.value) })} />
              </Field>
              <Field label="Max total">
                <Input inputMode="decimal" value={draft.maxTotal ?? ""} onChange={(e) => setDraft({ ...draft, maxTotal: e.target.value === "" ? undefined : Number(e.target.value) })} />
              </Field>
            </div>
            <Field label="Bill number">
              <Input inputMode="numeric" value={draft.billNo ?? ""} onChange={(e) => setDraft({ ...draft, billNo: e.target.value === "" ? undefined : Number(e.target.value) })} />
            </Field>

            {error && <p role="alert" className="text-[13px] text-[var(--danger,#b42318)]">{error}</p>}
          </div>
          <div className="flex gap-3 border-t border-line px-5 py-4">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" className="flex-1" onClick={apply}>Apply</Button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
```

Check `Field`, `Select`, `Button` prop names (`size`, `variant`) against `components/ui.tsx` and adjust; use the theme's danger token if one exists in `globals.css`.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @menu/web lint && pnpm --filter @menu/web exec vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/sales apps/web/lib/api-client.ts apps/web/components/sales
git commit -m "feat(web): sales filter in the URL and the filter bar

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Sales page and bill sheet

**Files:**
- Create: `apps/web/components/sales/bill-sheet.tsx`
- Create: `apps/web/app/(app)/sales/page.tsx`

**Interfaces:**
- Consumes: `useSalesFilter`, `FilterBar` (Task 9); `PaySheet` (Task 8); `SalesPage`, `BillRow`, `Totals` (Task 9 types); existing `GET orders/:id/bill`, `GET orders/:id/bill/pdf?format=`; `POST orders/:id/paid`; `PATCH bills/:billId/payment-mode`; existing `GET businesses/:bid/menu` (for categories/items) and `GET businesses/:bid/tables` (for labels).
- Produces: `/sales` route. `<BillSheet businessId currency row onClose onChanged />`.

- [ ] **Step 1: Check menu/tables response shapes**

Run: `grep -n "async getMenu\|async list" -A15 apps/api/src/menu/menu.service.ts apps/api/src/tables/tables.service.ts | head -60`
Use the actual field names (category `id`/`name`, item `id`/`name`/`categoryId`, table `label`) in Step 3.

- [ ] **Step 2: BillSheet** — `apps/web/components/sales/bill-sheet.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { PAYMENT_MODE_LABEL, formatMoney, type PaymentMode } from "@menu/shared";
import { api, downloadFile } from "@/lib/api-client";
import { Button, Sheet, SheetGrabber } from "@/components/ui";
import { PaySheet } from "./pay-sheet";
import type { BillRow } from "@/lib/sales/types";

interface FullBill {
  billNumber: number;
  tableLabel: string;
  issuedAt: string;
  subtotal: string;
  taxTotal: string;
  serviceCharge: string;
  roundOff: string;
  total: string;
  taxLabel: string;
  lines: { id: string; name: string; variant: string | null; quantity: number; lineTotal: string }[];
}

export function BillSheet({
  businessId,
  currency,
  row,
  onClose,
  onChanged,
}: {
  businessId: string;
  currency: string;
  row: BillRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [bill, setBill] = useState<FullBill | null>(null);
  const [paying, setPaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.get<FullBill>(`/businesses/${businessId}/orders/${row.orderId}/bill`).then(setBill);
  }, [businessId, row.orderId]);

  async function pick(mode: PaymentMode) {
    setBusy(true);
    setError(null);
    try {
      if (row.paymentMode) {
        await api.patch(`/businesses/${businessId}/bills/${row.id}/payment-mode`, { mode });
      } else {
        await api.post(`/businesses/${businessId}/orders/${row.orderId}/paid`, { mode });
      }
      setPaying(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const when = new Date(row.issuedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

  return (
    <Sheet label={`Bill ${row.billNumber}`} onClose={onClose} side="side">
      <SheetGrabber />
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <h2 className="text-[18px] font-semibold">Bill #{row.billNumber}</h2>
        <p className="mt-0.5 text-[13.5px] text-muted">Table {row.tableLabel} · {when}</p>
        <p className="mt-3 text-[13.5px]">
          {row.paymentMode
            ? <>Paid · <strong>{PAYMENT_MODE_LABEL[row.paymentMode]}</strong></>
            : <strong className="text-[var(--accent-strong)]">Unpaid</strong>}
        </p>

        {!bill ? (
          <div className="skeleton mt-5 h-40 rounded-xl" />
        ) : (
          <table className="mt-5 w-full text-[14px]">
            <tbody>
              {bill.lines.map((l) => (
                <tr key={l.id} className="border-b border-line">
                  <td className="py-2">{l.quantity} × {l.name}{l.variant ? ` (${l.variant})` : ""}</td>
                  <td className="tnum py-2 text-right">{formatMoney(l.lineTotal, currency)}</td>
                </tr>
              ))}
              <tr><td className="pt-3 text-muted">Subtotal</td><td className="tnum pt-3 text-right">{formatMoney(bill.subtotal, currency)}</td></tr>
              <tr><td className="text-muted">{bill.taxLabel}</td><td className="tnum text-right">{formatMoney(bill.taxTotal, currency)}</td></tr>
              {Number(bill.serviceCharge) > 0 && (
                <tr><td className="text-muted">Service charge</td><td className="tnum text-right">{formatMoney(bill.serviceCharge, currency)}</td></tr>
              )}
              {Number(bill.roundOff) !== 0 && (
                <tr><td className="text-muted">Round off</td><td className="tnum text-right">{formatMoney(bill.roundOff, currency)}</td></tr>
              )}
              <tr className="font-semibold"><td className="pt-2">Total</td><td className="tnum pt-2 text-right">{formatMoney(bill.total, currency)}</td></tr>
            </tbody>
          </table>
        )}
        {error && <p role="alert" className="mt-3 text-[13px] text-[var(--danger,#b42318)]">{error}</p>}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-line px-5 py-4">
        <Button variant="secondary" onClick={() => void downloadFile(`/businesses/${businessId}/orders/${row.orderId}/bill/pdf?format=bill`, `bill-${row.billNumber}.pdf`)}>
          Bill PDF
        </Button>
        <Button variant="secondary" onClick={() => void downloadFile(`/businesses/${businessId}/orders/${row.orderId}/bill/pdf?format=receipt`, `receipt-${row.billNumber}.pdf`)}>
          Receipt
        </Button>
        <Button variant="primary" className="ml-auto" onClick={() => setPaying(true)}>
          {row.paymentMode ? "Change mode" : "Mark paid"}
        </Button>
      </div>
      {paying && (
        <PaySheet
          title={row.paymentMode ? "Change payment mode" : `Mark bill #${row.billNumber} paid`}
          total={row.total}
          currency={currency}
          busy={busy}
          current={row.paymentMode}
          onPick={(m) => void pick(m)}
          onClose={() => setPaying(false)}
        />
      )}
    </Sheet>
  );
}
```

- [ ] **Step 3: Sales page** — `apps/web/app/(app)/sales/page.tsx`:

```tsx
"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { PAYMENT_MODE_LABEL, formatMoney, timezoneFor } from "@menu/shared";
import { api } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { Banner, Button, Empty, cx } from "@/components/ui";
import { FilterBar } from "@/components/sales/filter-bar";
import { BillSheet } from "@/components/sales/bill-sheet";
import { ExportDialog } from "@/components/sales/export-dialog";
import { useSalesFilter } from "@/components/sales/use-sales-filter";
import type { BillRow, SalesPage, Totals } from "@/lib/sales/types";

export default function SalesRoute() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <Sales />
    </Suspense>
  );
}

function Sales() {
  const { current } = useSession();
  const tz = timezoneFor(current?.country ?? "IN");
  const { filter, preset, setFilter, query } = useSalesFilter(tz);
  const [rows, setRows] = useState<BillRow[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<BillRow | null>(null);
  const [exporting, setExporting] = useState(false);
  const [lookups, setLookups] = useState<{ tables: string[]; categories: { id: string; name: string }[]; items: { id: string; name: string; categoryId: string }[] }>({ tables: [], categories: [], items: [] });

  const load = useCallback(async () => {
    if (!current) return;
    setLoading(true);
    try {
      const page = await api.get<SalesPage>(`/businesses/${current.id}/bills?${query}`);
      setRows(page.bills);
      setTotals(page.totals);
      setCursor(page.nextCursor);
    } finally {
      setLoading(false);
    }
  }, [current, query]);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (!current) return;
    // Adjust these two calls to the real menu/tables response shapes (Step 1).
    void Promise.all([
      api.get<{ label: string }[]>(`/businesses/${current.id}/tables`),
      api.get<{ categories: { id: string; name: string; items: { id: string; name: string }[] }[] }>(`/businesses/${current.id}/menu`),
    ]).then(([tables, menu]) =>
      setLookups({
        tables: tables.map((t) => t.label),
        categories: menu.categories.map((c) => ({ id: c.id, name: c.name })),
        items: menu.categories.flatMap((c) => c.items.map((i) => ({ id: i.id, name: i.name, categoryId: c.id }))),
      }),
    );
  }, [current]);

  async function more() {
    if (!current || !cursor) return;
    const page = await api.get<SalesPage>(`/businesses/${current.id}/bills?${query}&cursor=${encodeURIComponent(cursor)}`);
    setRows((r) => [...r, ...page.bills]);
    setCursor(page.nextCursor);
  }

  if (!current) return null;
  const money = (v: string) => formatMoney(v, current.currency);

  return (
    <div className="mx-auto max-w-5xl px-5 py-8 sm:px-6 sm:py-10 lg:px-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">Sales</h1>
          <p className="mt-1 text-[14px] text-muted">Every bill, for tallying and filing. Receipts showing tax, not GST tax invoices.</p>
        </div>
        <Button variant="primary" onClick={() => setExporting(true)} disabled={!totals?.count}>Export</Button>
      </header>

      <FilterBar tz={tz} filter={filter} preset={preset} onChange={setFilter} {...lookups} />

      {totals && (
        <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
          <Tot label="Bills" value={String(totals.count)} />
          <Tot label="Gross" value={money(totals.gross)} />
          <Tot label="Tax" value={money(totals.tax)} />
          <Tot label="Net (excl. tax)" value={money(totals.net)} />
          {(["cash", "upi", "card", "other"] as const).map((m) => (
            <Tot key={m} label={PAYMENT_MODE_LABEL[m]} value={money(totals.byMode[m])} />
          ))}
          <Tot label="Unpaid" value={money(totals.byMode.unpaid)} warn={Number(totals.byMode.unpaid) > 0} />
        </dl>
      )}

      <section className="mt-8">
        {loading ? (
          <div className="skeleton h-48 rounded-2xl" />
        ) : rows.length === 0 ? (
          <Empty title="No bills in this period" body="Change the dates or clear filters." />
        ) : (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {rows.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setOpen(r)}
                  className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-0.5 px-4 py-3 text-left hover:bg-[var(--raised)] sm:grid-cols-[6rem_1fr_6rem_8rem_7rem]">
                  <span className="tnum font-medium">#{r.billNumber}</span>
                  <span className="text-[13.5px] text-muted">
                    {new Date(r.issuedAt).toLocaleString("en-IN", { timeZone: tz, dateStyle: "medium", timeStyle: "short" })}
                    <span className="sm:hidden"> · Table {r.tableLabel}</span>
                  </span>
                  <span className="hidden text-[13.5px] sm:block">Table {r.tableLabel}</span>
                  <span className={cx("hidden w-fit rounded-full px-2 py-0.5 text-[12px] sm:block",
                    r.paymentMode ? "bg-[var(--raised)]" : "bg-[var(--accent-soft)] text-[var(--accent-strong)]")}>
                    {r.paymentMode ? `Paid · ${PAYMENT_MODE_LABEL[r.paymentMode]}` : "Unpaid"}
                  </span>
                  <span className="tnum text-right font-medium">{money(r.total)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {cursor && (
          <div className="mt-4 flex justify-center">
            <Button variant="secondary" onClick={() => void more()}>Load more</Button>
          </div>
        )}
      </section>

      {open && (
        <BillSheet businessId={current.id} currency={current.currency} row={open}
          onClose={() => setOpen(null)} onChanged={() => { setOpen(null); void load(); }} />
      )}
      {exporting && totals && (
        <ExportDialog businessId={current.id} businessName={current.name} filter={filter} query={query}
          billCount={totals.count} onClose={() => setExporting(false)} />
      )}
    </div>
  );
}

function Tot({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={cx("rounded-xl border px-3 py-2.5", warn ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-line bg-surface")}>
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="tnum mt-0.5 text-[17px] font-semibold">{value}</dd>
    </div>
  );
}
```

`ExportDialog` is created in Task 11. Until then, to keep this task independently testable, create `components/sales/export-dialog.tsx` with this stub, which Task 11 replaces:

```tsx
"use client";
import type { SalesFilter } from "@menu/shared";
export function ExportDialog(_props: { businessId: string; businessName: string; filter: SalesFilter; query: string; billCount: number; onClose: () => void }) {
  return null;
}
```

Check `Empty`'s props in `components/ui.tsx` (title/body names) and adjust.

- [ ] **Step 4: Typecheck + manual**

Run: `pnpm --filter @menu/web lint`
Expected: PASS.

Manual: open `/sales` → this month's bills with totals; switch to Yesterday; filter Unpaid → only unpaid; open one → lines show; Mark paid → Cash → row shows "Paid · Cash" and Unpaid total drops; Change mode → UPI; refresh keeps the filter.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(app)/sales" apps/web/components/sales
git commit -m "feat(web): Sales page with totals, bill detail and mark paid

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Browser-assembled export (CSVs + ZIP)

**Files:**
- Modify: `apps/web/package.json` (add `fflate`)
- Create: `apps/web/lib/sales/csv.ts`, `apps/web/lib/sales/csv.spec.ts`
- Create: `apps/web/lib/sales/export.ts`, `apps/web/lib/sales/export.spec.ts`
- Replace: `apps/web/components/sales/export-dialog.tsx`

**Interfaces:**
- Consumes: `ExportPage`, `ExportBill` (Task 9 types); `apiBinary` (Task 9); `GET bills/export/rows`, `POST bills/export/pdfs` (Task 5); `localToday`/`SalesFilter`.
- Produces:
  - `toCsv(rows: (string | number | boolean | null)[][]): string` (BOM + CRLF)
  - `registerCsv(bills, tz)`, `itemsCsv(bills, tz)`, `dailyCsv(bills, tz)`, `readmeText(meta)`
  - `localParts(iso: string, tz: string): { date: string; time: string }`
  - `runExport(opts): Promise<Uint8Array>` with
    ```ts
    opts: {
      fetchRows: (cursor: string | null) => Promise<ExportPage>;
      fetchPdfs: (billIds: string[]) => Promise<Uint8Array>; // a zip
      includePdfs: boolean;
      meta: { businessName: string; from: string; to: string; filtersText: string; generatedAt: string };
      onProgress: (p: { phase: "rows" | "pdfs"; done: number; total: number }) => void;
      signal: AbortSignal;
      batchSize?: number;   // default 25
      concurrency?: number; // default 2
      retries?: number;     // default 2
    }
    ```
  - `exportFileName(business: string, from: string, to: string): string` → `sales_<slug>_<from>_to_<to>.zip`

- [ ] **Step 1: Add dependency**

Run: `pnpm --filter @menu/web add fflate`

- [ ] **Step 2: Write the failing tests**

`apps/web/lib/sales/csv.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dailyCsv, itemsCsv, localParts, registerCsv, toCsv } from "./csv";
import type { ExportBill } from "./types";

const bill = (over: Partial<ExportBill> = {}): ExportBill => ({
  id: "b1", billNumber: 12, issuedAt: "2026-10-01T19:00:00.000Z", tableLabel: "Screen 2, Row F",
  paymentMode: "upi", paidAt: "2026-10-01T19:10:00.000Z", subtotal: "100.00", taxTotal: "5.00",
  serviceCharge: "0.00", roundOff: "0.00", total: "105.00", pricesIncludeTax: true, taxLabel: "GST", gstin: null,
  lines: [{ name: 'Tea "masala"', variant: "Large", category: "Drinks", quantity: 2, unitPrice: "52.50",
    lineTotal: "105.00", lineNet: "100.00", taxRate: "5.00", taxAmount: "5.00" }],
  ...over,
});

describe("toCsv", () => {
  it("starts with a BOM, uses CRLF, and quotes commas, quotes and newlines", () => {
    const out = toCsv([["a", 'say "hi"', "x,y", "line\nbreak", null, 3]]);
    expect(out.startsWith("﻿")).toBe(true);
    expect(out).toBe('﻿a,"say ""hi""","x,y","line\nbreak",,3\r\n');
  });
  it("neutralises spreadsheet formulas", () => {
    expect(toCsv([["=SUM(A1)"]])).toBe("﻿'=SUM(A1)\r\n");
  });
});

describe("localParts", () => {
  it("puts an after-midnight IST bill on the IST date", () => {
    expect(localParts("2026-10-01T19:00:00.000Z", "Asia/Kolkata")).toEqual({ date: "2026-10-02", time: "00:30" });
  });
});

describe("registerCsv", () => {
  it("has the agreed header and one row per bill", () => {
    const lines = registerCsv([bill(), bill({ id: "b2", billNumber: 13, paymentMode: null, paidAt: null })], "Asia/Kolkata")
      .replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("Bill No,Date,Time,Table,Status,Payment Mode,Paid At,Items,Subtotal,Tax,Service Charge,Round Off,Total,Prices Include Tax,Tax Label,GSTIN");
    expect(lines[1]).toBe('12,2026-10-02,00:30,"Screen 2, Row F",Paid,UPI,2026-10-02 00:40,2,100.00,5.00,0.00,0.00,105.00,Yes,GST,');
    expect(lines[2]).toContain(",Unpaid,,,");
  });
});

describe("itemsCsv", () => {
  it("has one row per line with category", () => {
    const lines = itemsCsv([bill()], "Asia/Kolkata").replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("Bill No,Date,Item,Variant,Category,Qty,Unit Price,Line Total,Net,Tax Rate %,Tax Amount");
    expect(lines[1]).toBe('12,2026-10-02,"Tea ""masala""",Large,Drinks,2,52.50,105.00,100.00,5.00,5.00');
  });
});

describe("dailyCsv", () => {
  it("sums per local day with a mode split and a total row", () => {
    const out = dailyCsv(
      [bill(), bill({ id: "b2", billNumber: 13, paymentMode: "cash", total: "50.00", subtotal: "47.62", taxTotal: "2.38" })],
      "Asia/Kolkata",
    ).replace("﻿", "").trim().split("\r\n");
    expect(out[0]).toBe("Date,Bills,Gross,Net,Tax,Service Charge,Round Off,Cash,UPI,Card,Other,Unpaid");
    expect(out[1]).toBe("2026-10-02,2,155.00,147.62,7.38,0.00,0.00,50.00,105.00,0.00,0.00,0.00");
    expect(out.at(-1)).toBe("Total,2,155.00,147.62,7.38,0.00,0.00,50.00,105.00,0.00,0.00,0.00");
  });
});
```

`apps/web/lib/sales/export.spec.ts`:

```ts
import { strFromU8, unzipSync, zipSync, strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { exportFileName, runExport } from "./export";
import type { ExportBill, ExportPage } from "./types";

const mk = (n: number): ExportBill => ({
  id: `id${n}`, billNumber: n, issuedAt: "2026-10-02T06:00:00.000Z", tableLabel: "1", paymentMode: "cash",
  paidAt: "2026-10-02T06:05:00.000Z", subtotal: "10.00", taxTotal: "0.00", serviceCharge: "0.00", roundOff: "0.00",
  total: "10.00", pricesIncludeTax: true, taxLabel: "GST", gstin: null, lines: [],
});

const meta = { businessName: "Cafe", from: "2026-10-01", to: "2026-10-31", filtersText: "None", generatedAt: "2026-10-03T00:00:00Z" };

function pages(total: number, per: number) {
  const bills = Array.from({ length: total }, (_, i) => mk(i + 1));
  return vi.fn(async (cursor: string | null): Promise<ExportPage> => {
    const start = cursor ? Number(cursor) : 0;
    const slice = bills.slice(start, start + per);
    return { business: { name: "Cafe", timezone: "Asia/Kolkata", currency: "INR" }, bills: slice,
      nextCursor: start + per < total ? String(start + per) : null };
  });
}

const pdfZip = (ids: string[]) =>
  zipSync(Object.fromEntries(ids.map((id) => [`bill-${id.replace("id", "").padStart(6, "0")}.pdf`, strToU8(`%PDF ${id}`)])));

describe("runExport", () => {
  it("pages rows, batches PDFs, and writes CSVs + README", async () => {
    const fetchPdfs = vi.fn(async (ids: string[]) => pdfZip(ids));
    const zip = await runExport({
      fetchRows: pages(60, 25), fetchPdfs, includePdfs: true, meta,
      onProgress: () => {}, signal: new AbortController().signal, batchSize: 25,
    });
    const files = unzipSync(zip);
    expect(Object.keys(files).filter((f) => f.startsWith("bills/"))).toHaveLength(60);
    expect(files["sales-register.csv"]).toBeDefined();
    expect(files["bill-items.csv"]).toBeDefined();
    expect(files["daily-summary.csv"]).toBeDefined();
    expect(strFromU8(files["README.txt"]!)).toContain("not GST tax invoices");
    expect(fetchPdfs).toHaveBeenCalledTimes(3); // 25 + 25 + 10
  });

  it("retries a failed batch, then succeeds", async () => {
    let fails = 1;
    const fetchPdfs = vi.fn(async (ids: string[]) => {
      if (fails-- > 0) throw new Error("network");
      return pdfZip(ids);
    });
    await runExport({ fetchRows: pages(5, 25), fetchPdfs, includePdfs: true, meta, onProgress: () => {}, signal: new AbortController().signal });
    expect(fetchPdfs).toHaveBeenCalledTimes(2);
  });

  it("gives up after retries and produces nothing", async () => {
    const fetchPdfs = vi.fn(async () => { throw new Error("network"); });
    await expect(
      runExport({ fetchRows: pages(5, 25), fetchPdfs, includePdfs: true, meta, onProgress: () => {}, signal: new AbortController().signal, retries: 2 }),
    ).rejects.toThrow(/bills 1–5/);
    expect(fetchPdfs).toHaveBeenCalledTimes(3);
  });

  it("refuses a batch that came back short", async () => {
    const fetchPdfs = vi.fn(async (ids: string[]) => pdfZip(ids.slice(1)));
    await expect(
      runExport({ fetchRows: pages(3, 25), fetchPdfs, includePdfs: true, meta, onProgress: () => {}, signal: new AbortController().signal, retries: 0 }),
    ).rejects.toThrow();
  });

  it("CSV-only skips PDFs entirely", async () => {
    const fetchPdfs = vi.fn();
    const zip = await runExport({ fetchRows: pages(3, 25), fetchPdfs, includePdfs: false, meta, onProgress: () => {}, signal: new AbortController().signal });
    expect(fetchPdfs).not.toHaveBeenCalled();
    expect(Object.keys(unzipSync(zip)).some((f) => f.startsWith("bills/"))).toBe(false);
  });

  it("stops when cancelled", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      runExport({ fetchRows: pages(3, 25), fetchPdfs: vi.fn(), includePdfs: true, meta, onProgress: () => {}, signal: ctrl.signal }),
    ).rejects.toThrow(/cancel/i);
  });
});

describe("exportFileName", () => {
  it("slugs the business name", () => {
    expect(exportFileName("Chai & Co. Café", "2026-04-01", "2027-03-31")).toBe("sales_chai-co-cafe_2026-04-01_to_2027-03-31.zip");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @menu/web exec vitest run lib/sales`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement CSV** — `apps/web/lib/sales/csv.ts`:

```ts
import { PAYMENT_MODE_LABEL } from "@menu/shared";
import type { ExportBill } from "./types";

type Cell = string | number | boolean | null | undefined;

/**
 * RFC 4180, with a BOM so Excel reads UTF-8 (₹, é) correctly. A cell that
 * starts like a formula is prefixed with an apostrophe: a dish called
 * "=HYPERLINK(...)" must not become a live formula in the accountant's sheet.
 */
export function toCsv(rows: Cell[][]): string {
  const cell = (v: Cell): string => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function localParts(iso: string, tz: string): { date: string; time: string } {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return { date, time };
}

/** Sum money strings in paise to avoid float drift, back to 2 decimals. */
function sum(values: string[]): string {
  const paise = values.reduce((a, v) => a + Math.round(Number(v) * 100), 0);
  return (paise / 100).toFixed(2);
}

export function registerCsv(bills: ExportBill[], tz: string): string {
  return toCsv([
    ["Bill No", "Date", "Time", "Table", "Status", "Payment Mode", "Paid At", "Items", "Subtotal", "Tax",
      "Service Charge", "Round Off", "Total", "Prices Include Tax", "Tax Label", "GSTIN"],
    ...bills.map((b) => {
      const { date, time } = localParts(b.issuedAt, tz);
      const paid = b.paidAt ? localParts(b.paidAt, tz) : null;
      return [
        b.billNumber, date, time, b.tableLabel, b.paymentMode ? "Paid" : "Unpaid",
        b.paymentMode ? PAYMENT_MODE_LABEL[b.paymentMode] : "", paid ? `${paid.date} ${paid.time}` : "",
        b.lines.reduce((a, l) => a + l.quantity, 0),
        b.subtotal, b.taxTotal, b.serviceCharge, b.roundOff, b.total,
        b.pricesIncludeTax ? "Yes" : "No", b.taxLabel, b.gstin ?? "",
      ];
    }),
  ]);
}

export function itemsCsv(bills: ExportBill[], tz: string): string {
  return toCsv([
    ["Bill No", "Date", "Item", "Variant", "Category", "Qty", "Unit Price", "Line Total", "Net", "Tax Rate %", "Tax Amount"],
    ...bills.flatMap((b) => {
      const { date } = localParts(b.issuedAt, tz);
      return b.lines.map((l) => [
        b.billNumber, date, l.name, l.variant ?? "", l.category, l.quantity, l.unitPrice, l.lineTotal, l.lineNet, l.taxRate, l.taxAmount,
      ]);
    }),
  ]);
}

export function dailyCsv(bills: ExportBill[], tz: string): string {
  const byDay = new Map<string, ExportBill[]>();
  for (const b of bills) {
    const { date } = localParts(b.issuedAt, tz);
    byDay.set(date, [...(byDay.get(date) ?? []), b]);
  }
  const row = (label: string, list: ExportBill[]) => {
    const mode = (m: string | null) => sum(list.filter((b) => b.paymentMode === m).map((b) => b.total));
    return [
      label, list.length, sum(list.map((b) => b.total)),
      sum(list.map((b) => (Number(b.total) - Number(b.taxTotal)).toFixed(2))),
      sum(list.map((b) => b.taxTotal)), sum(list.map((b) => b.serviceCharge)), sum(list.map((b) => b.roundOff)),
      mode("cash"), mode("upi"), mode("card"), mode("other"), mode(null),
    ];
  };
  return toCsv([
    ["Date", "Bills", "Gross", "Net", "Tax", "Service Charge", "Round Off", "Cash", "UPI", "Card", "Other", "Unpaid"],
    ...[...byDay.keys()].sort().map((d) => row(d, byDay.get(d)!)),
    row("Total", bills),
  ]);
}

export function readmeText(meta: { businessName: string; from: string; to: string; timezone: string; filtersText: string; generatedAt: string; bills: number; includesPdfs: boolean }): string {
  return [
    `Sales export — ${meta.businessName}`,
    `Period: ${meta.from} to ${meta.to} (${meta.timezone})`,
    `Filters: ${meta.filtersText}`,
    `Bills: ${meta.bills}`,
    `Generated: ${meta.generatedAt}`,
    "",
    "sales-register.csv  one row per bill",
    "bill-items.csv      one row per item on each bill",
    "daily-summary.csv   totals per day, with the payment split; last row is the period total",
    meta.includesPdfs ? "bills/              the A5 bill for each bill number" : "",
    "",
    "Gross = bill total. Net = total excluding tax. Unpaid = bills not marked paid.",
    "These are receipts showing tax, not GST tax invoices.",
    "",
  ].join("\r\n");
}
```

- [ ] **Step 5: Implement export** — `apps/web/lib/sales/export.ts`:

```ts
import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { dailyCsv, itemsCsv, readmeText, registerCsv } from "./csv";
import type { ExportBill, ExportPage } from "./types";

export interface RunExportOptions {
  fetchRows: (cursor: string | null) => Promise<ExportPage>;
  fetchPdfs: (billIds: string[]) => Promise<Uint8Array>;
  includePdfs: boolean;
  meta: { businessName: string; from: string; to: string; filtersText: string; generatedAt: string };
  onProgress: (p: { phase: "rows" | "pdfs"; done: number; total: number }) => void;
  signal: AbortSignal;
  batchSize?: number;
  concurrency?: number;
  retries?: number;
}

function checkCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Export cancelled");
}

/**
 * Builds the export in the browser from small, quick requests — the API is
 * serverless and cannot render a year of PDFs in one 30-second call.
 *
 * All or nothing: a batch that fails after its retries, or returns fewer
 * PDFs than asked for, aborts the export. A ZIP with a bill silently missing
 * is worse than no ZIP.
 */
export async function runExport(o: RunExportOptions): Promise<Uint8Array> {
  const batchSize = o.batchSize ?? 25;
  const concurrency = o.concurrency ?? 2;
  const retries = o.retries ?? 2;

  const bills: ExportBill[] = [];
  let timezone = "UTC";
  let cursor: string | null = null;
  do {
    checkCancelled(o.signal);
    const page: ExportPage = await o.fetchRows(cursor);
    timezone = page.business.timezone;
    bills.push(...page.bills);
    cursor = page.nextCursor;
    o.onProgress({ phase: "rows", done: bills.length, total: bills.length });
  } while (cursor);

  const files: Zippable = {
    "sales-register.csv": strToU8(registerCsv(bills, timezone)),
    "bill-items.csv": strToU8(itemsCsv(bills, timezone)),
    "daily-summary.csv": strToU8(dailyCsv(bills, timezone)),
    "README.txt": strToU8(readmeText({ ...o.meta, timezone, bills: bills.length, includesPdfs: o.includePdfs })),
  };

  if (o.includePdfs && bills.length) {
    const batches: ExportBill[][] = [];
    for (let i = 0; i < bills.length; i += batchSize) batches.push(bills.slice(i, i + batchSize));
    let done = 0;
    let next = 0;
    o.onProgress({ phase: "pdfs", done, total: bills.length });

    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++]!;
        const ids = batch.map((b) => b.id);
        let attempt = 0;
        for (;;) {
          checkCancelled(o.signal);
          try {
            const entries = unzipSync(await o.fetchPdfs(ids));
            const names = Object.keys(entries);
            if (names.length !== batch.length) throw new Error("short batch");
            for (const name of names) files[`bills/${name}`] = [entries[name]!, { level: 0 }];
            break;
          } catch (err) {
            if (o.signal.aborted) throw new Error("Export cancelled");
            if (attempt++ >= retries) {
              throw new Error(
                `Could not fetch bills ${batch[0]!.billNumber}–${batch[batch.length - 1]!.billNumber}. Check your connection and try again.`,
              );
            }
          }
        }
        done += batch.length;
        o.onProgress({ phase: "pdfs", done, total: bills.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  }

  checkCancelled(o.signal);
  return zipSync(files);
}

export function exportFileName(business: string, from: string, to: string): string {
  const slug = business
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `sales_${slug || "business"}_${from}_to_${to}.zip`;
}
```

Note on the "gives up" test: the error names bills `1–5` because `pages(5, 25)` creates bills numbered 1–5.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @menu/web exec vitest run lib/sales`
Expected: PASS.

- [ ] **Step 7: Export dialog** — replace `apps/web/components/sales/export-dialog.tsx`:

```tsx
"use client";

import { useRef, useState } from "react";
import { PAYMENT_MODE_LABEL, type SalesFilter } from "@menu/shared";
import { api, apiBinary } from "@/lib/api-client";
import { runExport, exportFileName } from "@/lib/sales/export";
import type { ExportPage } from "@/lib/sales/types";
import { Banner, Button, Sheet, SheetGrabber } from "@/components/ui";

const LARGE = 3000;

function describe(f: SalesFilter): string {
  const parts: string[] = [];
  if (f.modes?.length) parts.push(`payment: ${f.modes.map((m) => (m === "unpaid" ? "Unpaid" : PAYMENT_MODE_LABEL[m])).join(", ")}`);
  if (f.tables?.length) parts.push(`tables: ${f.tables.join(", ")}`);
  if (f.categoryId) parts.push("one category");
  if (f.menuItemId) parts.push("one dish");
  if (f.minTotal !== undefined || f.maxTotal !== undefined) parts.push(`total ${f.minTotal ?? 0}–${f.maxTotal ?? "any"}`);
  if (f.billNo !== undefined) parts.push(`bill #${f.billNo}`);
  return parts.length ? parts.join("; ") : "None";
}

export function ExportDialog({
  businessId,
  businessName,
  filter,
  query,
  billCount,
  onClose,
}: {
  businessId: string;
  businessName: string;
  filter: SalesFilter;
  query: string;
  billCount: number;
  onClose: () => void;
}) {
  const [includePdfs, setIncludePdfs] = useState(true);
  const [progress, setProgress] = useState<{ phase: "rows" | "pdfs"; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  async function start() {
    setError(null);
    ctrl.current = new AbortController();
    try {
      const zip = await runExport({
        fetchRows: (cursor) =>
          api.get<ExportPage>(`/businesses/${businessId}/bills/export/rows?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
        fetchPdfs: (billIds) => apiBinary(`/businesses/${businessId}/bills/export/pdfs`, { billIds }),
        includePdfs,
        meta: { businessName, from: filter.from, to: filter.to, filtersText: describe(filter), generatedAt: new Date().toISOString() },
        onProgress: setProgress,
        signal: ctrl.current.signal,
      });
      const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = exportFileName(businessName, filter.from, filter.to);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
      setProgress(null);
    }
  }

  const running = progress !== null && !error;

  return (
    <Sheet label="Export sales" onClose={() => { ctrl.current?.abort(); onClose(); }}>
      <SheetGrabber />
      <div className="px-5 pb-6 pt-4 sm:px-6">
        <h2 className="text-[17px] font-semibold">Export {billCount} bill{billCount === 1 ? "" : "s"}</h2>
        <p className="mt-1 text-[13.5px] text-muted">{filter.from} → {filter.to}. Filters: {describe(filter)}.</p>

        {!running && (
          <fieldset className="mt-5 space-y-2">
            <label className="flex items-start gap-3">
              <input type="radio" checked={includePdfs} onChange={() => setIncludePdfs(true)} className="mt-1" />
              <span><strong>Bills + spreadsheets</strong><br /><span className="text-[13px] text-muted">Every bill as a PDF, plus the CSVs.</span></span>
            </label>
            <label className="flex items-start gap-3">
              <input type="radio" checked={!includePdfs} onChange={() => setIncludePdfs(false)} className="mt-1" />
              <span><strong>Spreadsheets only</strong><br /><span className="text-[13px] text-muted">Sales register, items and daily summary. Fast.</span></span>
            </label>
          </fieldset>
        )}

        {includePdfs && billCount > LARGE && !running && (
          <Banner className="mt-4">This is a large export and takes a few minutes. Keep this tab open until it finishes.</Banner>
        )}

        {running && (
          <div className="mt-5" aria-live="polite">
            <p className="tnum text-[14px]">
              {progress.phase === "rows" ? `Reading bills… ${progress.done}` : `Preparing bills ${progress.done} / ${progress.total}`}
            </p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-[var(--accent)] transition-[width]"
                style={{ width: progress.phase === "pdfs" && progress.total ? `${(progress.done / progress.total) * 100}%` : "8%" }} />
            </div>
          </div>
        )}

        {error && <p role="alert" className="mt-4 text-[13.5px] text-[var(--danger,#b42318)]">{error}</p>}

        <div className="mt-6 flex gap-3">
          {running ? (
            <Button variant="ghost" onClick={() => ctrl.current?.abort()}>Cancel</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>Close</Button>
              <Button variant="primary" className="flex-1" onClick={() => void start()}>
                {error ? "Try again" : "Download ZIP"}
              </Button>
            </>
          )}
        </div>
      </div>
    </Sheet>
  );
}
```

Check `Banner`'s props in `components/ui.tsx` (it may take `tone`/`children`) and adjust.

- [ ] **Step 8: Typecheck + manual**

Run: `pnpm --filter @menu/web lint && pnpm --filter @menu/web exec vitest run`
Expected: PASS.

Manual: `/sales` → Export → Spreadsheets only → ZIP downloads; open `sales-register.csv` in Excel/LibreOffice: ₹-free numbers, correct local dates, Status/Mode columns. Export with bills → `bills/` folder has one PDF per bill, opening one shows the A5 bill.

- [ ] **Step 9: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/lib/sales apps/web/components/sales/export-dialog.tsx
git commit -m "feat(web): export a period as a ZIP of bills and CSVs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Insights page and charts

**Files:**
- Create: `apps/web/components/insights/charts.tsx`
- Create: `apps/web/components/insights/kpi.tsx`
- Create: `apps/web/app/(app)/insights/page.tsx`

**Interfaces:**
- Consumes: `Analytics` (Task 9 types), `useSalesFilter`, `FilterBar` (Task 9); `GET analytics` (Task 6).
- Produces: `/insights` route; chart components `BarSeries`, `StackedShare`, `HBars`, `Heatmap`, `Distribution`; `KpiTile`, `pctChange(current: string, previous: string): number | null`.

- [ ] **Step 1: Load the dataviz skill** — invoke `dataviz` before writing any chart code and follow its colour, mark and interaction rules; map its palette onto this app's theme tokens (`--accent`, `--accent-soft`, `--line`, `--ink`, `--muted`) so light and dark both work. The tenant accent is the only colour in the interface (README "Brand") — use accent for the primary series and greys/opacity steps of ink for secondary categories rather than a rainbow palette.

- [ ] **Step 2: Write the failing test** — `apps/web/components/insights/kpi.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pctChange } from "./kpi";

describe("pctChange", () => {
  it("computes change against the previous period", () => {
    expect(pctChange("150", "100")).toBe(50);
    expect(pctChange("50", "100")).toBe(-50);
  });
  it("has no percentage when there was nothing before", () => {
    expect(pctChange("100", "0")).toBeNull();
  });
});
```

Run: `pnpm --filter @menu/web exec vitest run components/insights` — Expected: FAIL (module not found).

- [ ] **Step 3: KPI** — `apps/web/components/insights/kpi.tsx`:

```tsx
import { cx } from "@/components/ui";

export function pctChange(current: string, previous: string): number | null {
  const p = Number(previous);
  if (!p) return null;
  return Math.round(((Number(current) - p) / p) * 1000) / 10;
}

export function KpiTile({ label, value, current, previous, warn }: {
  label: string;
  value: string;
  current?: string;
  previous?: string;
  warn?: boolean;
}) {
  const change = current !== undefined && previous !== undefined ? pctChange(current, previous) : null;
  return (
    <div className={cx("rounded-2xl border px-4 py-3.5", warn ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-line bg-surface")}>
      <p className="text-[12.5px] text-muted">{label}</p>
      <p className="tnum mt-1 text-[24px] font-semibold leading-none tracking-tight">{value}</p>
      {change !== null && (
        <p className="tnum mt-1.5 text-[12.5px] text-muted">
          <span aria-hidden="true">{change >= 0 ? "▲" : "▼"}</span> {Math.abs(change)}%
          <span className="sr-only">{change >= 0 ? "up" : "down"}</span> vs previous period
        </p>
      )}
    </div>
  );
}
```

Run the test — Expected: PASS.

- [ ] **Step 4: Charts** — `apps/web/components/insights/charts.tsx`. Each component is inline SVG with a `viewBox` that scales to its container width, an accessible `<title>`/`aria-label` summary, a visible empty state when all values are zero, and a hover/focus tooltip implemented as a positioned `<div>` (state: hovered index). Required components and props:

```tsx
"use client";

import { useState } from "react";

export function BarSeries({ points, format, label }: {
  points: { start: string; gross: string; bills: number }[];
  format: (v: string) => string;
  label: string;
}) { /* vertical bars of gross per bucket; x labels thinned to ≤ 8; tooltip "date · ₹x · n bills" */ }

export function StackedShare({ parts, format }: {
  parts: { label: string; value: string }[]; // payment mix incl. Unpaid
  format: (v: string) => string;
}) { /* one 100%-wide stacked bar + legend with value and % */ }

export function HBars({ rows, format }: {
  rows: { label: string; value: string; sub?: string }[]; // tables, categories
  format: (v: string) => string;
}) { /* horizontal bars sorted desc, label left, value right */ }

export function Heatmap({ cells, format }: {
  cells: { dow: number; hour: number; bills: number; gross: string }[]; // dow 1..7 Mon..Sun
  format: (v: string) => string;
}) { /* 7 rows × 24 cols; opacity of accent by bills; only hours that ever have data shown as columns on narrow screens */ }

export function Distribution({ counts }: { counts: number[] /* index 0 = 1★ */ }) { /* 5 small bars, 1★..5★ */ }
```

Write each body fully, following the dataviz skill. Keep everything in this one file unless it passes ~400 lines, then split per chart.

- [ ] **Step 5: Page** — `apps/web/app/(app)/insights/page.tsx`:

```tsx
"use client";

import { Suspense, useEffect, useState } from "react";
import { CANCELLATION_REASON_LABEL, PAYMENT_MODE_LABEL, formatMoney, timezoneFor } from "@menu/shared";
import { api } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { Empty, Segmented } from "@/components/ui";
import { FilterBar } from "@/components/sales/filter-bar";
import { useSalesFilter } from "@/components/sales/use-sales-filter";
import { KpiTile } from "@/components/insights/kpi";
import { BarSeries, Distribution, HBars, Heatmap, StackedShare } from "@/components/insights/charts";
import type { Analytics } from "@/lib/sales/types";

export default function InsightsRoute() {
  return (
    <Suspense fallback={null}>
      <Insights />
    </Suspense>
  );
}

function Insights() {
  const { current } = useSession();
  const tz = timezoneFor(current?.country ?? "IN");
  const { filter, preset, setFilter, query } = useSalesFilter(tz);
  const [data, setData] = useState<Analytics | null>(null);
  const [itemSort, setItemSort] = useState<"gross" | "qty">("gross");
  const [lookups, setLookups] = useState<{ tables: string[]; categories: { id: string; name: string }[]; items: { id: string; name: string; categoryId: string }[] }>({ tables: [], categories: [], items: [] });

  useEffect(() => {
    if (!current) return;
    setData(null);
    void api.get<Analytics>(`/businesses/${current.id}/analytics?${query}`).then(setData);
  }, [current, query]);

  // Same lookups as the Sales page — copy that effect verbatim (menu + tables).

  if (!current) return null;
  const money = (v: string) => formatMoney(v, current.currency);
  const k = data?.kpis;

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-6 sm:py-10 lg:px-10">
      <header className="mb-6">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">Insights</h1>
        <p className="mt-1 text-[14px] text-muted">How the business is doing, with the same filters as Sales.</p>
      </header>

      <FilterBar tz={tz} filter={filter} preset={preset} onChange={setFilter} {...lookups} />

      {!data || !k ? (
        <div className="skeleton mt-8 h-96 rounded-2xl" />
      ) : k.current.count === 0 ? (
        <div className="mt-10"><Empty title="No sales in this period" body="Pick a different period or clear filters." /></div>
      ) : (
        <div className="mt-8 space-y-8">
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-6">
            <KpiTile label="Gross sales" value={money(k.current.gross)} current={k.current.gross} previous={k.previous.gross} />
            <KpiTile label="Bills" value={String(k.current.count)} current={String(k.current.count)} previous={String(k.previous.count)} />
            <KpiTile label="Average bill" value={money(k.current.avgBill)} current={k.current.avgBill} previous={k.previous.avgBill} />
            <KpiTile label="Items sold" value={String(k.current.itemsSold)} current={String(k.current.itemsSold)} previous={String(k.previous.itemsSold)} />
            <KpiTile label="Paid digitally"
              value={`${Math.round(((Number(k.current.byMode.upi) + Number(k.current.byMode.card) + Number(k.current.byMode.other)) / Math.max(1, Number(k.current.gross) - Number(k.current.byMode.unpaid))) * 100)}%`} />
            <KpiTile label="Unpaid" value={money(k.current.byMode.unpaid)} warn={Number(k.current.byMode.unpaid) > 0} />
          </section>

          <Card title="Sales over time" note={`By ${data.series.bucket}`}>
            <BarSeries points={data.series.points} format={money} label="Gross sales" />
          </Card>

          <div className="grid gap-8 lg:grid-cols-2">
            <Card title="How people paid">
              <StackedShare format={money} parts={[
                ...(["cash", "upi", "card", "other"] as const).map((m) => ({ label: PAYMENT_MODE_LABEL[m], value: k.current.byMode[m] })),
                { label: "Unpaid", value: k.current.byMode.unpaid },
              ]} />
            </Card>
            <Card title="Tables">
              <HBars format={money} rows={data.tables.map((t) => ({ label: t.label, value: t.gross, sub: `${t.bills} bills` }))} />
            </Card>
          </div>

          <Card title="Top dishes" action={
            <Segmented label="Sort dishes" value={itemSort} onChange={setItemSort}
              options={[{ value: "gross", label: "Revenue" }, { value: "qty", label: "Quantity" }]} />
          }>
            <table className="w-full text-[14px]">
              <thead className="text-left text-[12px] text-muted">
                <tr><th className="py-1.5 font-medium">Dish</th><th className="font-medium">Category</th><th className="text-right font-medium">Qty</th><th className="text-right font-medium">Revenue</th></tr>
              </thead>
              <tbody>
                {[...data.items].sort((a, b) => itemSort === "qty" ? b.qty - a.qty : Number(b.gross) - Number(a.gross)).slice(0, 20).map((i) => (
                  <tr key={`${i.name}|${i.variant ?? ""}`} className="border-t border-line">
                    <td className="py-2">{i.name}{i.variant ? ` (${i.variant})` : ""}</td>
                    <td className="text-muted">{i.category}</td>
                    <td className="tnum text-right">{i.qty}</td>
                    <td className="tnum text-right">{money(i.gross)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="grid gap-8 lg:grid-cols-2">
            <Card title="Categories">
              <HBars format={money} rows={data.categories.map((c) => ({ label: c.category, value: c.gross, sub: `${c.qty} sold` }))} />
            </Card>
            <Card title="Busy hours" note={`Bills by weekday and hour (${data.timezone})`}>
              <Heatmap cells={data.heatmap} format={money} />
            </Card>
          </div>

          <div className="grid gap-8 lg:grid-cols-3">
            <Card title="Kitchen times" note={`Median minutes, ${data.kitchen.orders} orders`}>
              <dl className="grid grid-cols-2 gap-3 text-[14px]">
                {([["Wait to accept", data.kitchen.toAccept], ["Prep", data.kitchen.toReady], ["Serve", data.kitchen.toServe], ["Pay", data.kitchen.toPay]] as const).map(([l, v]) => (
                  <div key={l}><dt className="text-[12px] text-muted">{l}</dt><dd className="tnum text-[20px] font-semibold">{v === null ? "—" : `${v} min`}</dd></div>
                ))}
              </dl>
            </Card>
            <Card title="Cancellations" note="Date range only">
              <p className="tnum text-[20px] font-semibold">{data.cancellations.units} items · {money(data.cancellations.value)}</p>
              <ul className="mt-3 space-y-1 text-[13.5px]">
                {data.cancellations.byReason.map((r) => (
                  <li key={r.reason} className="flex justify-between"><span>{CANCELLATION_REASON_LABEL[r.reason as keyof typeof CANCELLATION_REASON_LABEL] ?? r.reason}</span><span className="tnum">{r.units}</span></li>
                ))}
              </ul>
            </Card>
            <Card title="Ratings" note={data.ratings.count ? `${data.ratings.average}★ from ${data.ratings.count}` : "No ratings yet"}>
              <Distribution counts={data.ratings.distribution} />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ title, note, action, children }: { title: string; note?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-[15px] font-semibold">{title}</h2>
          {note && <p className="text-[12.5px] text-muted">{note}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
```

Check the exact name of the cancellation reason label export in `packages/shared/src/enums.ts` (`grep -n "REASON" packages/shared/src/enums.ts`) and use it; if none exists, use the reason string.

- [ ] **Step 6: Typecheck + manual**

Run: `pnpm --filter @menu/web lint && pnpm --filter @menu/web exec vitest run`
Expected: PASS.

Manual: `/insights` this month — KPIs with ▲/▼, bars per day, payment mix, tables, top dishes (sort toggle), heatmap, kitchen times, cancellations, ratings. Switch to This FY → bars become months. Toggle dark mode — all charts legible. Phone width (375px) — no horizontal page scroll.

- [ ] **Step 7: Commit**

```bash
git add "apps/web/app/(app)/insights" apps/web/components/insights
git commit -m "feat(web): Insights page with sales analytics

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Navigation and the Overview "Today" card

**Files:**
- Modify: `apps/web/app/(app)/layout.tsx`
- Modify: `apps/web/app/(app)/dashboard/page.tsx`

**Interfaces:**
- Consumes: `/sales`, `/insights` routes; `GET bills?from=today&to=today` (Task 4); `localToday`, `timezoneFor`.

- [ ] **Step 1: Nav** — in `layout.tsx` `NAV`, after the Orders entry:

```ts
  { href: "/sales",       label: "Sales",          icon: SalesIcon },
  { href: "/insights",    label: "Insights",       icon: InsightsIcon },
```

and add icons next to `BillingIcon`, using the same `icon(...)` helper:

```tsx
function SalesIcon() {
  return icon(
    <>
      <path d="M4 4h16v16H4Z" />
      <path d="M4 9h16M9 9v11" />
    </>,
  );
}

function InsightsIcon() {
  return icon(
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>,
  );
}
```

Active-state matching uses `pathname === item.href`; `/sales?…` has pathname `/sales`, so no change needed.

- [ ] **Step 2: Today card** — in `dashboard/page.tsx`, add state and a fetch next to the existing summary fetch:

```ts
  const [today, setToday] = useState<Totals | null>(null);
```
```ts
    const day = localToday(timezoneFor(current.country));
    void api
      .get<SalesPage>(`/businesses/${current.id}/bills?from=${day}&to=${day}`)
      .then((p) => setToday(p.totals));
```

Render, directly above the existing stats grid:

```tsx
          {today && (
            <Link href="/insights?p=today" className="spring block rounded-2xl border border-line bg-surface px-5 py-4 hover:border-[var(--accent-soft)] hover:shadow-lift">
              <p className="text-[12.5px] text-muted">Today</p>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-6 gap-y-1">
                <span className="tnum text-[26px] font-semibold tracking-tight">{formatMoney(today.gross, current.currency)}</span>
                <span className="tnum text-[14px] text-muted">{today.count} bill{today.count === 1 ? "" : "s"}</span>
                {Number(today.byMode.unpaid) > 0 && (
                  <span className="tnum text-[14px] font-medium text-[var(--accent-strong)]">{formatMoney(today.byMode.unpaid, current.currency)} unpaid</span>
                )}
              </div>
            </Link>
          )}
```

(Imports: `Link` from `next/link`, `formatMoney, localToday, timezoneFor` from `@menu/shared`, `type { SalesPage, Totals }` from `@/lib/sales/types`.)

- [ ] **Step 3: Typecheck + manual**

Run: `pnpm --filter @menu/web lint`
Expected: PASS. Manual: nav shows Sales and Insights after Orders on desktop and the mobile nav; Overview shows Today; clicking it opens Insights on Today.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/(app)/layout.tsx" "apps/web/app/(app)/dashboard/page.tsx"
git commit -m "feat(web): Sales and Insights in the nav, today's sales on Overview

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: End-to-end test and CLAUDE.md

**Files:**
- Create: `apps/web/e2e/sales.spec.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Read the existing e2e helpers**

Run: `sed -n 1,80p apps/web/e2e/ordering.spec.ts`
Reuse its signup / menu / table / scan helpers exactly (same function names and flow) in the new spec.

- [ ] **Step 2: Write the e2e** — `apps/web/e2e/sales.spec.ts`. Using the helpers from `ordering.spec.ts`, implement one test `"served → paid by UPI → Sales → export → Insights"`:
  1. Sign up a fresh owner, add one category + one dish priced ₹100, create table "E2E 1", resolve its token in a second browser context (the diner) and place an order for 1 dish.
  2. In the owner page, `/orders`: Accept → Ready → **Served**. Assert the card appears under **To collect** with "₹105" (₹100 + 5% service charge).
  3. Tap **Paid** → **UPI**. Assert the card leaves To collect and history shows "UPI".
  4. Go to `/sales`. Assert one row with "Paid · UPI" and the UPI total tile shows ₹105 and Unpaid ₹0.
  5. Click **Export** → **Spreadsheets only** → **Download ZIP**; capture with `page.waitForEvent("download")`; read the file with `fflate.unzipSync` (import from `fflate`); assert `sales-register.csv` contains `,Paid,UPI,` and `README.txt` contains `not GST tax invoices`.
  6. Go to `/insights?p=today`. Assert the Gross sales tile shows ₹105 and "Bills" shows 1.
  7. Diner context: call `GET /api/table/bill` and assert 200 (bill still downloadable after payment); `POST /api/table/bill/service-charge/remove` must return a non-2xx status. For this to be meaningful, step 1 also turns service charge on (5%) in `/billing` before the order is placed, and step 2 asserts the To collect total is ₹105.

- [ ] **Step 3: Run it**

Run (dev servers up, DB migrated): `pnpm --filter @menu/web e2e -- e2e/sales.spec.ts`
Expected: 1 passed. Also run the full suite once: `pnpm --filter @menu/web e2e` — existing specs must still pass (ordering/billing specs may need "Served" to be followed by nothing — they should be unaffected; if a spec asserted the history list contents, update it for the new To collect column).

- [ ] **Step 4: Update CLAUDE.md** — edit the existing (untracked) `CLAUDE.md` at repo root:
  - Commands: add `pnpm --filter @menu/web exec vitest run` and `pnpm --filter @menu/shared exec vitest run` (both packages now have vitest); note `DIRECT_URL` is required alongside `DATABASE_URL` (Prisma `directUrl`) and the API also deploys as a Vercel serverless function (`api/index.ts` → `apps/api/dist/serverless.js`, 30 s / ~4.5 MB limits — long work must be batched, see the sales export).
  - Remove the stale note that `notifications/` holds the OTP drivers (now `otp/channels/`); mention `notifications/` is order notifications (web push + realtime).
  - Architecture: add a **Sales & Insights** bullet: one `salesFilterSchema` (shared) → `billWhere` (`apps/api/src/sales/sales-filter.sql.ts`) used by list, export and analytics; reports are in the business's local timezone from `timezoneFor(country)`; ZIP is assembled in the browser (`apps/web/lib/sales/export.ts`).
  - Invariants: add "Order statuses meaning *finished* (`completed`, `paid`) and *open* are hand-listed in SQL functions (`place_table_round`, `get_table_order`, `get_ratable_order`) and the partial index — change `transitions.ts` and those together. `paid` is set only via `POST orders/:id/paid` with a payment mode; a paid bill's service charge cannot be removed."

- [ ] **Step 5: Final verification**

Run:
```bash
pnpm --filter @menu/shared build
pnpm lint
pnpm test
pnpm --filter @menu/api test:isolation
pnpm --filter @menu/web e2e
```
Expected: all pass; isolation ends `PASS — no cross-tenant access.`

- [ ] **Step 6: Commit**

```bash
git add apps/web/e2e/sales.spec.ts CLAUDE.md
git commit -m "test(web): sales end-to-end; docs: CLAUDE.md for sales and the recent pull

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Spec deviations recorded here

- `GET bills` returns summary rows (`BillRow`), not full bills with lines; the bill sheet loads the full bill from the existing `GET orders/:id/bill`. Smaller pages, same information.
- Cancellations in Insights honour the date range only (cancelled lines never reach a bill, so bill-level filters have nothing to match); the card says so.
- Top dishes returns up to 200 rows grouped by dish so the client can sort by quantity or revenue without a second request.
