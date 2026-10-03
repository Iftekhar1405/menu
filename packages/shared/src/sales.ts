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
