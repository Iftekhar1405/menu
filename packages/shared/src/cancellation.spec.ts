import { describe, expect, it } from "vitest";
import {
  CANCELLABLE_STATUSES,
  CANCELLATION_REASONS,
  CANCELLATION_REASON_LABEL,
  CANCELLATION_REASON_STAFF_LABEL,
  cancellationRemarkRequired,
} from "./enums";
import { businessUpdateSchema, cancelOrderSchema } from "./schemas";

const LINE = { orderItemId: "6f8f8b5e-2b9f-4f1e-9f0a-1c2d3e4f5a6b", quantity: 1 };

describe("cancellation reasons", () => {
  it("labels every reason on both sides of the counter", () => {
    for (const reason of CANCELLATION_REASONS) {
      expect(CANCELLATION_REASON_LABEL[reason]).toBeTruthy();
      expect(CANCELLATION_REASON_STAFF_LABEL[reason]).toBeTruthy();
    }
  });

  it("asks for a remark only when the reason says nothing on its own", () => {
    expect(cancellationRemarkRequired("other")).toBe(true);
    for (const reason of CANCELLATION_REASONS.filter((r) => r !== "other")) {
      expect(cancellationRemarkRequired(reason)).toBe(false);
    }
  });

  it("never offers a status a cancellation could not apply to", () => {
    expect([...CANCELLABLE_STATUSES]).not.toContain("completed");
    expect([...CANCELLABLE_STATUSES]).not.toContain("cancelled");
  });
});

describe("cancelOrderSchema", () => {
  it("takes the whole order when no lines are named", () => {
    const parsed = cancelOrderSchema.parse({ reason: "changed_mind" });
    expect(parsed.lines).toBeUndefined();
  });

  it("accepts named lines with a remark", () => {
    const parsed = cancelOrderSchema.parse({
      lines: [LINE],
      reason: "mistake",
      remark: "  tapped twice  ",
    });
    expect(parsed.remark).toBe("tapped twice");
  });

  it("rejects 'something else' with nothing written", () => {
    expect(() => cancelOrderSchema.parse({ reason: "other" })).toThrow();
    expect(() => cancelOrderSchema.parse({ reason: "other", remark: "   " })).toThrow();
  });

  it("accepts 'something else' once it is explained", () => {
    const parsed = cancelOrderSchema.parse({
      reason: "other",
      remark: "allergy we did not spot on the menu",
    });
    expect(parsed.reason).toBe("other");
  });

  it("rejects a reason that is not on the list", () => {
    expect(() => cancelOrderSchema.parse({ reason: "vibes" })).toThrow();
  });

  it("rejects a line cancelling nothing", () => {
    expect(() =>
      cancelOrderSchema.parse({
        lines: [{ ...LINE, quantity: 0 }],
        reason: "mistake",
      }),
    ).toThrow();
  });
});

describe("businessUpdateSchema cancellation settings", () => {
  it("accepts a policy an owner could plausibly set", () => {
    const parsed = businessUpdateSchema.parse({
      cancellationEnabled: true,
      cancellationWindowMins: 5,
      cancellationStatuses: ["placed", "preparing"],
      cancellationItemsEnabled: false,
    });
    expect(parsed.cancellationStatuses).toEqual(["placed", "preparing"]);
  });

  it("allows ticking nothing, which means nobody can cancel", () => {
    expect(businessUpdateSchema.parse({ cancellationStatuses: [] })
      .cancellationStatuses).toEqual([]);
  });

  it("refuses a window of zero or one longer than two hours", () => {
    expect(() => businessUpdateSchema.parse({ cancellationWindowMins: 0 })).toThrow();
    expect(() => businessUpdateSchema.parse({ cancellationWindowMins: 121 })).toThrow();
  });

  it("refuses a status the kitchen board has already finished with", () => {
    expect(() =>
      businessUpdateSchema.parse({ cancellationStatuses: ["completed"] }),
    ).toThrow();
  });
});
