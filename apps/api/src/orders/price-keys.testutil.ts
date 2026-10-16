/**
 * Walks anything and reports every key that could carry money.
 *
 * Mirrors `PRICE_KEYS` in kitchen-shape.ts exactly — every name in that set
 * must appear here too, or a key could be dropped from the implementation
 * without any test noticing.
 *
 * Shared rather than copied: the leak this catches is not confined to the
 * board listing. Any response reaching a kitchen caller has to be scanned the
 * same way, and a second hand-written copy of the key list is exactly how one
 * of them would quietly stop covering `rounds[].items[]`.
 */
export function priceKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) { value.forEach((v) => priceKeys(v, found)); return found; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/^(unitPrice|price|taxRate|lineTotal|lineNet|taxAmount|total)$/.test(k)) found.push(k);
      priceKeys(v, found);
    }
  }
  return found;
}
