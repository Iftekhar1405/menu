import { describe, expect, it } from "vitest";
import { stripPrices } from "./kitchen-shape";

/**
 * Walks anything and reports every key that could carry money.
 *
 * Mirrors `PRICE_KEYS` in kitchen-shape.ts exactly — every name in that set
 * must appear here too, or a key could be dropped from the implementation
 * without any test noticing.
 */
function priceKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) { value.forEach((v) => priceKeys(v, found)); return found; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/^(unitPrice|price|taxRate|lineTotal|lineNet|taxAmount|total)$/.test(k)) found.push(k);
      priceKeys(v, found);
    }
  }
  return found;
}

const BOARD = [{
  id: "o1",
  status: "placed",
  placedAt: new Date("2026-01-01T00:00:00.000Z"),
  items: [{
    id: "i1",
    nameSnapshot: "Dosa",
    quantity: 2,
    unitPrice: "120.00",
    lineTotal: "240.00",
    lineNet: "228.57",
    taxAmount: "11.43",
  }],
  // The board groups by round now, so the same prices appear a second time
  // one level deeper. A recursive walk covers that for free — but only this
  // fixture proves the shape the board actually sends is the shape walked.
  rounds: [{
    id: "r1",
    seq: 1,
    kotNumber: 7,
    status: "placed",
    items: [{ id: "i1", nameSnapshot: "Dosa", quantity: 2, unitPrice: "120.00" }],
  }],
  cancellations: [{ id: "c1", nameSnapshot: "Idli", quantity: 1, unitPrice: "60.00" }],
  total: "240.00",
}];

describe("stripPrices", () => {
  it("leaves an owner's payload the same reference, not a copy", () => {
    const out = stripPrices(BOARD, "owner");
    expect(out).toBe(BOARD);
    expect(out[0]).toBe(BOARD[0]);
    expect(out[0]!.items).toBe(BOARD[0]!.items);
    expect(out[0]!.placedAt).toBe(BOARD[0]!.placedAt);
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

  it("keeps a Date as a Date rather than flattening it into a plain object", () => {
    const out = stripPrices(BOARD, "kitchen") as typeof BOARD;
    expect(out[0]!.placedAt).toBeInstanceOf(Date);
    expect(out[0]!.placedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("strips the notifications wrapper without disturbing cursor, channel or pushPublicKey", () => {
    const wrapper = {
      items: [{ id: 1, kind: "order_placed", title: "Table 4", body: "", data: {}, orderId: "o1", tableId: "t1" }],
      unread: 3,
      cursor: 42,
      channel: "biz:abc123",
      pushPublicKey: "BExamplePublicKey==",
    };
    const out = stripPrices(wrapper, "kitchen");
    expect(out.cursor).toBe(42);
    expect(typeof out.cursor).toBe("number");
    expect(out.channel).toBe("biz:abc123");
    expect(out.pushPublicKey).toBe("BExamplePublicKey==");
    expect(out.unread).toBe(3);
    expect(priceKeys(out)).toEqual([]);
  });
});
