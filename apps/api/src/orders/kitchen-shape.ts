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
