import { describe, expect, it } from "vitest";
import { stripPrices } from "./kitchen-shape";

/** Walks anything and reports every key that could carry money. */
function priceKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) { value.forEach((v) => priceKeys(v, found)); return found; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/^(unitPrice|price|taxRate|lineTotal|total)$/.test(k)) found.push(k);
      priceKeys(v, found);
    }
  }
  return found;
}

const BOARD = [{
  id: "o1",
  status: "placed",
  items: [{ id: "i1", nameSnapshot: "Dosa", quantity: 2, unitPrice: "120.00" }],
  cancellations: [{ id: "c1", nameSnapshot: "Idli", quantity: 1, unitPrice: "60.00" }],
}];

describe("stripPrices", () => {
  it("leaves an owner's payload exactly as it was", () => {
    expect(stripPrices(BOARD, "owner")).toEqual(BOARD);
  });

  it("removes every price from a kitchen payload, at any depth", () => {
    expect(priceKeys(stripPrices(BOARD, "kitchen"))).toEqual([]);
  });

  it("keeps everything the kitchen actually needs", () => {
    const out = stripPrices(BOARD, "kitchen") as typeof BOARD;
    expect(out[0]!.items[0]!.nameSnapshot).toBe("Dosa");
    expect(out[0]!.items[0]!.quantity).toBe(2);
    expect(out[0]!.status).toBe("placed");
  });

  it("strips nested menu shapes too", () => {
    const menu = [{ name: "Mains", items: [{ name: "Dosa", price: "120.00", taxRate: "5.00", variants: [{ name: "L", price: "150.00" }] }] }];
    expect(priceKeys(stripPrices(menu, "kitchen"))).toEqual([]);
  });
});
