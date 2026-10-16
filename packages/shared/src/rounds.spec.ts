import { describe, expect, it } from "vitest";
import { deriveOrderStatus } from "./rounds";

describe("deriveOrderStatus", () => {
  it("is the least advanced live round", () => {
    // The whole point: round 1 ready, round 2 just placed -> the order is
    // placed, because something on this table has not been started.
    expect(deriveOrderStatus(["ready", "placed"])).toBe("placed");
    expect(deriveOrderStatus(["completed", "preparing"])).toBe("preparing");
  });

  it("completes when every round is terminal and one completed", () => {
    expect(deriveOrderStatus(["completed", "cancelled"])).toBe("completed");
  });

  it("cancels only when every round is cancelled", () => {
    expect(deriveOrderStatus(["cancelled", "cancelled"])).toBe("cancelled");
  });
});
