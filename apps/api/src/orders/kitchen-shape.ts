import type { AccessRole } from "@menu/shared";

/**
 * Keys that carry money. Removed rather than zeroed: a zero is a number a
 * screen will happily render, and "₹0.00" on a kitchen board is worse than
 * no column at all.
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
