import { describe, expect, it } from "vitest";
import type { OrderStatus } from "@prisma/client";
import {
  ALLOWED_TRANSITIONS,
  OPEN_STATUSES,
  ORDER_STATUSES,
  canTransition,
} from "./transitions";

/** Declaration order, which is also the order Postgres sorts the enum in. */
const FLOW: OrderStatus[] = ["placed", "accepted", "preparing", "ready", "completed"];

describe("order transitions", () => {
  it("lets every stage move to the one after it", () => {
    for (let i = 0; i < FLOW.length - 1; i++) {
      expect(canTransition(FLOW[i]!, FLOW[i + 1]!)).toBe(true);
    }
  });

  it("allows skipping forward, because a rush should not be four forced taps", () => {
    expect(canTransition("placed", "ready")).toBe(true);
    expect(canTransition("placed", "completed")).toBe(true);
    expect(canTransition("accepted", "ready")).toBe(true);
  });

  it("refuses every backward move", () => {
    for (let i = 0; i < FLOW.length; i++) {
      for (let j = 0; j < i; j++) {
        expect(canTransition(FLOW[i]!, FLOW[j]!)).toBe(false);
      }
    }
  });

  it("refuses to reopen a finished order", () => {
    expect(ALLOWED_TRANSITIONS.completed).toEqual([]);
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]);
  });

  it("lets anything unfinished be cancelled", () => {
    for (const status of OPEN_STATUSES) {
      expect(canTransition(status, "cancelled")).toBe(true);
    }
  });

  it("counts accepted as open, so the order stays on the board", () => {
    expect(OPEN_STATUSES).toEqual(["placed", "accepted", "preparing", "ready"]);
  });

  it("never lets a status move to itself", () => {
    for (const status of ORDER_STATUSES) {
      expect(canTransition(status as OrderStatus, status as OrderStatus)).toBe(false);
    }
  });
});
