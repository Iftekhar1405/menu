import type { AccessRole } from "@menu/shared";

/**
 * Keys that carry money. Removed rather than zeroed: a zero is a number a
 * screen will happily render, and "₹0.00" on a kitchen board is worse than
 * no column at all.
 *
 * This list is RESPONSE-SCOPED, not schema-exhaustive: it covers every money
 * key that actually appears in the six responses opened to kitchen staff
 * (order items/cancellations, and menu items/variants). It is not a copy of
 * every `Decimal` column in schema.prisma — `defaultTaxRate`,
 * `serviceChargeRate`, `subtotal`, `taxTotal`, `serviceCharge`, and
 * `roundOff` are deliberately absent because nothing stripped here returns
 * them. If a future call site's query starts selecting one of those, add its
 * key here rather than assuming this set already has it covered.
 */
const PRICE_KEYS = new Set([
  "unitPrice", "price", "taxRate", "lineTotal", "lineNet", "taxAmount", "total",
]);

/**
 * A formatted amount anywhere inside a sentence: "₹180", "₹1,250.50", "$40".
 *
 * `Intl.NumberFormat` puts the symbol before the digits for every currency
 * this product ships with, and `formatMoney` is the only thing that writes
 * money into these strings.
 */
const MONEY_IN_TEXT = /[₹$€£¥] ?\s?\d[\d,]*(?:\.\d+)?/g;

/**
 * Removes money from a notification's already-rendered text.
 *
 * Key-based stripping cannot help here: `notifications.title` and `body` are
 * whole sentences composed at emit time by notifications/events.ts, which
 * interpolates `formatMoney(...)` directly into them — so a kitchen user was
 * reading "Coffee (Small), Chinese Bhel (Large) · ₹180" while every other
 * surface correctly showed them no prices at all.
 *
 * The better fix is for events.ts to stop baking the total into the sentence
 * and let each reader decide whether to render it. That is a schema change
 * (the amount would have to live in `data`), and it would not help the rows
 * already written — including every notification from before kitchen logins
 * existed. Redacting at read time is what makes the existing history safe to
 * show, so it is needed regardless of what emit does later.
 *
 * Separators are tidied afterwards so a redacted middle segment does not
 * leave "lines ·  · reason" behind.
 */
export function redactMoneyFromText(text: string): string {
  // Split on the separator rather than patching punctuation afterwards: money
  // is a whole segment ("lines · ₹120 · reason"), and dropping the segment
  // keeps the remaining ones correctly spaced no matter where it sat. Trying
  // to stitch the dots back together with a second regex is what produced
  // "Coffee (Small)· Ordered by mistake".
  return text
    .split("·")
    .map((part) => part.replace(MONEY_IN_TEXT, "").trim())
    .filter((part) => part.length > 0)
    .join(" · ");
}

/**
 * Strips money from anything on its way to a kitchen caller.
 *
 * Done here, at the boundary, rather than by each query choosing its own
 * `select`. Prisma's selects are written per call site and a new include is
 * exactly how a price finds its way back in; one recursive pass over the
 * response cannot be forgotten in the same way.
 */
export function stripPrices<T>(value: T, role: AccessRole): T {
  if (role === "owner") return value;
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  // `Date` must be returned as-is, not walked as a plain object: the generic
  // branch below would enumerate its internal state into a dead `{}` with no
  // `.toISOString()`. A Prisma `Decimal` that reached this function at a
  // position that is not a known price key would suffer the same fate —
  // flattened into a bare `{s, e, d}` — but no current response puts a
  // `Decimal` anywhere but behind a key already in `PRICE_KEYS`, so there is
  // no special case for it here. Do not add one speculatively.
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (PRICE_KEYS.has(k)) continue;
      out[k] = walk(v);
    }
    return out;
  }
  return value;
}
