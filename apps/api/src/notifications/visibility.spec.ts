import { describe, expect, it } from "vitest";
import { cursorFor, pendingFor, visibleTo } from "./visibility";

const JOINED = new Date("2026-10-04T09:00:00.000Z");

describe("what each role may read", () => {
  it("gives the owner their whole venue, with no gate on acceptance", () => {
    const w = visibleTo("owner", "b1", null);
    expect(w).toEqual({ businessId: "b1" });
  });

  it("floors a staff feed at the day they joined", () => {
    expect(visibleTo("kitchen", "b1", JOINED)).toMatchObject({
      createdAt: { gte: JOINED },
    });
  });

  it("hides an order nobody has accepted from the kitchen", () => {
    expect(visibleTo("kitchen", "b1", JOINED).OR).toEqual([
      { orderId: null },
      { order: { events: { some: { kind: { in: ["accepted", "preparing", "ready"] } } } } },
    ]);
  });

  // The owner may take an order straight from `placed` to `preparing` — the
  // state machine allows skipping `accepted`. Testing for the accept event
  // alone would hide an order that is sitting on the kitchen's own board.
  it("shows an order that skipped straight past accepted", () => {
    const kinds = (visibleTo("kitchen", "b1", null).OR as never[])[1];
    expect(JSON.stringify(kinds)).toContain("preparing");
  });

  // The important one. An order cancelled mid-cook is `cancelled` now but was
  // accepted earlier, and "stop making this" is the notification the kitchen
  // most needs. Reading acceptance from the event log rather than the current
  // status is what keeps it visible.
  it("asks whether the order was ever accepted, not what it is now", () => {
    const or = visibleTo("kitchen", "b1", null).OR;
    expect(JSON.stringify(or)).not.toContain("status");
  });
});

describe("rows that are hidden but still coming", () => {
  it("has none for an owner", () => {
    expect(pendingFor("owner", "b1", null)).toBeNull();
  });

  // Only `placed`. An order cancelled out of `placed` can never be accepted,
  // so treating it as pending would pin the kitchen's cursor there for the
  // rest of the evening.
  it("counts only orders still waiting to be accepted", () => {
    expect(pendingFor("kitchen", "b1", JOINED)).toEqual({
      businessId: "b1",
      createdAt: { gte: JOINED },
      order: { is: { status: "placed" } },
    });
  });
});

describe("the cursor", () => {
  it("is the newest id when nothing is waiting", () => {
    expect(cursorFor(120, null)).toBe(120);
  });

  it("stops just below the oldest row still waiting on an accept", () => {
    expect(cursorFor(120, 104)).toBe(103);
  });

  it("never runs ahead of what the reader can actually see", () => {
    expect(cursorFor(100, 140)).toBe(100);
  });

  it("is 0 for a feed whose very first row is still waiting", () => {
    expect(cursorFor(0, 1)).toBe(0);
  });
});
