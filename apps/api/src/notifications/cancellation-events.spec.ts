import { describe, expect, it } from "vitest";
import {
  cancellationNotificationCopy,
  type CancellationSummary,
} from "./events";

function summary(patch: Partial<CancellationSummary> = {}): CancellationSummary {
  return {
    tableLabel: "12",
    dailyNumber: 7,
    currency: "INR",
    orderCancelled: false,
    lines: [{ name: "Masala Dosa", variant: null, quantity: 2, unitPrice: "165.00" }],
    reason: "changed_mind",
    remark: null,
    ...patch,
  };
}

describe("cancellationNotificationCopy", () => {
  it("names the table and the dish the kitchen has to stop making", () => {
    const { title, body } = cancellationNotificationCopy(summary());
    expect(title).toContain("Table 12");
    expect(body).toContain("2× Masala Dosa");
  });

  it("distinguishes losing a dish from losing the whole order", () => {
    expect(cancellationNotificationCopy(summary()).kind).toBe("order.item_cancelled");
    expect(cancellationNotificationCopy(summary({ orderCancelled: true })).kind).toBe(
      "order.cancelled",
    );
    expect(cancellationNotificationCopy(summary({ orderCancelled: true })).title).toContain(
      "Order cancelled",
    );
  });

  it("states the reason in the owner's words, not the diner's", () => {
    expect(cancellationNotificationCopy(summary()).body).toContain("Changed their mind");
    expect(
      cancellationNotificationCopy(summary({ reason: "too_slow" })).body,
    ).toContain("Taking too long");
  });

  it("carries the remark when there is one, and no empty quotes when there is not", () => {
    expect(cancellationNotificationCopy(summary()).body).not.toContain("“");
    expect(
      cancellationNotificationCopy(summary({ remark: "  allergy  " })).body,
    ).toContain("“allergy”");
  });

  it("truncates a long remark rather than burying the dish", () => {
    const body = cancellationNotificationCopy(
      summary({ remark: "a".repeat(200) }),
    ).body;
    expect(body).toContain("2× Masala Dosa");
    expect(body).toContain("…");
    expect(body.length).toBeLessThan(160);
  });

  it("sums the money back in minor units", () => {
    const body = cancellationNotificationCopy(
      summary({
        lines: [
          { name: "Filter Coffee", variant: null, quantity: 3, unitPrice: "40.10" },
          { name: "Vada", variant: null, quantity: 1, unitPrice: "55.20" },
        ],
      }),
    ).body;
    // 3 × 40.10 + 55.20 = 175.50, and not 175.50000000000003.
    expect(body).toContain("175.50");
  });

  it("summarises past three dishes rather than listing eleven", () => {
    const body = cancellationNotificationCopy(
      summary({
        lines: Array.from({ length: 5 }, (_, i) => ({
          name: `Dish ${i}`,
          variant: null,
          quantity: 1,
          unitPrice: "10.00",
        })),
      }),
    ).body;
    expect(body).toContain("+2 more");
  });

  it("says just the dish when there is one of it", () => {
    const body = cancellationNotificationCopy(
      summary({
        lines: [{ name: "Vada", variant: null, quantity: 1, unitPrice: "55.00" }],
      }),
    ).body;
    expect(body).toContain("Vada");
    expect(body).not.toContain("1× Vada");
  });
});
