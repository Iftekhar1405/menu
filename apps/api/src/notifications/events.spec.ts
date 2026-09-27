import { describe, expect, it } from "vitest";
import { staffNotificationCopy, type OrderRoundSummary } from "./events";

const base: OrderRoundSummary = {
  tableLabel: "12",
  dailyNumber: 7,
  currency: "INR",
  lines: [
    { name: "Masala Dosa", quantity: 2 },
    { name: "Filter Coffee", quantity: 1 },
  ],
  total: "450",
};

describe("staff notification copy", () => {
  it("names the table first, because that is what staff act on", () => {
    const { title } = staffNotificationCopy("order.placed", base);
    expect(title).toBe("New order · Table 12");
  });

  it("distinguishes a second round from a first order", () => {
    // Staff behave differently: a new order needs a ticket, a round gets
    // added to one already on the pass.
    const { title } = staffNotificationCopy("order.round_added", base);
    expect(title).toBe("Added to Table 12");
  });

  it("puts what was ordered and the money in the body", () => {
    const { body } = staffNotificationCopy("order.placed", base);
    expect(body).toContain("2× Masala Dosa");
    expect(body).toContain("Filter Coffee");
    expect(body).toContain("₹450");
  });

  it("drops the quantity prefix when there is only one", () => {
    const { body } = staffNotificationCopy("order.placed", base);
    expect(body).toContain("Filter Coffee");
    expect(body).not.toContain("1× Filter Coffee");
  });

  it("truncates a long order rather than producing an unreadable notification", () => {
    // A push notification gets two lines on a phone. Listing eleven dishes
    // means the reader sees neither the dishes nor the total.
    const long = {
      ...base,
      lines: Array.from({ length: 11 }, (_, i) => ({ name: `Dish ${i + 1}`, quantity: 1 })),
    };
    const { body } = staffNotificationCopy("order.placed", long);
    expect(body).toContain("Dish 1");
    expect(body).toContain("+8 more");
    expect(body).not.toContain("Dish 9");
  });

  it("formats money in the business's own currency", () => {
    const { body } = staffNotificationCopy("order.placed", { ...base, currency: "USD" });
    expect(body).toContain("$450");
  });

  it("survives an order whose lines did not come back", () => {
    // Defensive: the body is built from a jsonb payload, and a notification
    // that says nothing is still better than an exception on the order path.
    const { title, body } = staffNotificationCopy("order.placed", { ...base, lines: [] });
    expect(title).toBe("New order · Table 12");
    expect(body).toContain("₹450");
  });
});

import { summariseNewestRound, type PlacedOrder } from "./events";

function order(items: PlacedOrder["items"]): PlacedOrder {
  return {
    id: "order-1",
    status: "placed",
    dailyNumber: 7,
    tableLabel: "12",
    currency: "INR",
    items,
    total: "0",
  };
}

describe("summariseNewestRound", () => {
  it("calls a first batch a new order", () => {
    const result = summariseNewestRound(
      order([{ name: "Dosa", variant: null, unitPrice: "150.00", quantity: 2, batch: 1 }]),
    );
    expect(result?.kind).toBe("order.placed");
  });

  it("calls a later batch an added round", () => {
    const result = summariseNewestRound(
      order([
        { name: "Dosa", variant: null, unitPrice: "150.00", quantity: 2, batch: 1 },
        { name: "Chai", variant: null, unitPrice: "40.00", quantity: 1, batch: 2 },
      ]),
    );
    expect(result?.kind).toBe("order.round_added");
  });

  it("describes only the newest batch, not the whole order", () => {
    // The kitchen already has batch 1 on a ticket. Re-announcing it would
    // have staff cook the first round twice.
    const result = summariseNewestRound(
      order([
        { name: "Dosa", variant: null, unitPrice: "150.00", quantity: 2, batch: 1 },
        { name: "Chai", variant: null, unitPrice: "40.00", quantity: 1, batch: 2 },
      ]),
    );
    expect(result?.summary.lines).toEqual([{ name: "Chai", quantity: 1 }]);
    expect(result?.summary.total).toBe("40.00");
  });

  it("includes the variant, which is what staff actually make", () => {
    const result = summariseNewestRound(
      order([{ name: "Dosa", variant: "Large", unitPrice: "180.00", quantity: 1, batch: 1 }]),
    );
    expect(result?.summary.lines[0]!.name).toBe("Dosa (Large)");
  });

  it("totals the batch without floating-point drift", () => {
    // 0.1 + 0.2 arithmetic on money is how a notification ends up saying
    // ₹330.00000000000006.
    const result = summariseNewestRound(
      order([
        { name: "A", variant: null, unitPrice: "0.10", quantity: 1, batch: 1 },
        { name: "B", variant: null, unitPrice: "0.20", quantity: 1, batch: 1 },
      ]),
    );
    expect(result?.summary.total).toBe("0.30");
  });

  it("returns nothing for an order with no items", () => {
    // Nothing happened worth announcing, and a notification saying so would
    // be noise on a counter tablet.
    expect(summariseNewestRound(order([]))).toBeNull();
  });
});
