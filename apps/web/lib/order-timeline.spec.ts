import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  formatClock,
  formatGap,
  type OrderEvent,
} from "./order-timeline";

/** Events are built by hand so each test states exactly what happened. */
function event(id: number, kind: string, at: string, data?: OrderEvent["data"]): OrderEvent {
  return { id, kind, at, data: data ?? {} };
}

const PLACED = event(1, "placed", "2026-09-27T14:30:00Z", {
  batch: 1,
  items: [
    { name: "Masala Dosa", quantity: 2 },
    { name: "Filter Coffee", quantity: 1 },
  ],
});

describe("formatClock", () => {
  it("renders a 12-hour clock with a lowercase meridiem", () => {
    expect(formatClock("2026-09-27T14:32:00Z", "UTC")).toBe("2:32pm");
    expect(formatClock("2026-09-27T08:05:00Z", "UTC")).toBe("8:05am");
  });

  it("renders midnight and noon the way a person reads them", () => {
    expect(formatClock("2026-09-27T00:00:00Z", "UTC")).toBe("12:00am");
    expect(formatClock("2026-09-27T12:00:00Z", "UTC")).toBe("12:00pm");
  });
});

describe("formatGap", () => {
  it("does not round a real wait down to nothing", () => {
    expect(formatGap(0)).toBe("+<1m");
    expect(formatGap(45_000)).toBe("+<1m");
  });

  it("counts whole minutes", () => {
    expect(formatGap(2 * 60_000)).toBe("+2m");
    expect(formatGap(59 * 60_000)).toBe("+59m");
  });

  it("breaks an hour out rather than reading +64m", () => {
    expect(formatGap(64 * 60_000)).toBe("+1h 4m");
    expect(formatGap(120 * 60_000)).toBe("+2h");
  });
});

describe("buildTimeline", () => {
  it("marks the latest status current and the rest done", () => {
    const steps = buildTimeline(
      [
        PLACED,
        event(2, "accepted", "2026-09-27T14:32:00Z"),
        event(3, "preparing", "2026-09-27T14:34:00Z"),
      ],
      { status: "preparing", showUpcoming: false },
    );

    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ["Placed", "done"],
      ["Accepted", "done"],
      ["Being made", "current"],
    ]);
  });

  it("names the round's size on the placed step", () => {
    const [placed] = buildTimeline([PLACED], { status: "placed", showUpcoming: false });
    expect(placed!.detail).toBe("3 items");
  });

  it("says 1 item, not 1 items", () => {
    const one = event(1, "placed", "2026-09-27T14:30:00Z", {
      batch: 1,
      items: [{ name: "Filter Coffee", quantity: 1 }],
    });
    const [placed] = buildTimeline([one], { status: "placed", showUpcoming: false });
    expect(placed!.detail).toBe("1 item");
  });

  it("shows what has not happened yet when asked", () => {
    const steps = buildTimeline(
      [PLACED, event(2, "accepted", "2026-09-27T14:32:00Z")],
      { status: "accepted", showUpcoming: true },
    );

    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ["Placed", "done"],
      ["Accepted", "current"],
      ["Being made", "upcoming"],
      ["Ready", "upcoming"],
      ["Served", "upcoming"],
    ]);
    expect(steps.at(-1)!.at).toBeNull();
  });

  it("does not invent a stage the kitchen skipped", () => {
    // Staff tapped Ready on an order still marked New.
    const steps = buildTimeline(
      [PLACED, event(2, "ready", "2026-09-27T14:41:00Z")],
      { status: "ready", showUpcoming: true },
    );

    expect(steps.map((s) => s.label)).toEqual(["Placed", "Ready", "Served"]);
    expect(steps.map((s) => s.state)).toEqual(["done", "current", "upcoming"]);
  });

  it("promises nothing further once an order is cancelled", () => {
    const steps = buildTimeline(
      [PLACED, event(2, "cancelled", "2026-09-27T14:35:00Z")],
      { status: "cancelled", showUpcoming: true },
    );

    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ["Placed", "done"],
      ["Cancelled", "current"],
    ]);
  });

  it("promises nothing further once an order is served", () => {
    const steps = buildTimeline(
      [PLACED, event(2, "completed", "2026-09-27T15:00:00Z")],
      { status: "completed", showUpcoming: true },
    );
    expect(steps.every((s) => s.state !== "upcoming")).toBe(true);
  });

  it("explains a total that grew, in the order it grew", () => {
    const steps = buildTimeline(
      [
        PLACED,
        event(2, "accepted", "2026-09-27T14:32:00Z"),
        event(3, "preparing", "2026-09-27T14:34:00Z"),
        event(4, "round_added", "2026-09-27T14:41:00Z", {
          batch: 2,
          items: [{ name: "Gulab Jamun", quantity: 2 }],
        }),
        event(5, "ready", "2026-09-27T14:49:00Z"),
      ],
      { status: "ready", showUpcoming: false },
    );

    expect(steps.map((s) => s.label)).toEqual([
      "Placed",
      "Accepted",
      "Being made",
      "Round 2 added",
      "Ready",
    ]);
    // A round is a fact, never the thing the order is waiting on.
    expect(steps[3]!.state).toBe("done");
    expect(steps[3]!.detail).toBe("2 items");
    expect(steps[4]!.state).toBe("current");
  });

  it("renders a backfilled order rather than crashing on its gaps", () => {
    // Orders that predate the event log have only these two rows, and the
    // placed event carries no items at all.
    const steps = buildTimeline(
      [
        event(1, "placed", "2026-09-27T14:30:00Z"),
        event(2, "completed", "2026-09-27T15:02:00Z"),
      ],
      { status: "completed", showUpcoming: true },
    );

    expect(steps.map((s) => s.label)).toEqual(["Placed", "Served"]);
    expect(steps[0]!.detail).toBeNull();
    expect(steps[1]!.sincePreviousMs).toBe(32 * 60_000);
  });

  it("measures each gap from the step before it", () => {
    const steps = buildTimeline(
      [
        PLACED,
        event(2, "accepted", "2026-09-27T14:32:00Z"),
        event(3, "preparing", "2026-09-27T14:34:00Z"),
      ],
      { status: "preparing", showUpcoming: false },
    );

    expect(steps.map((s) => s.sincePreviousMs)).toEqual([null, 2 * 60_000, 2 * 60_000]);
  });

  it("survives an empty log", () => {
    expect(buildTimeline([], { status: "placed", showUpcoming: false })).toEqual([]);
  });

  it("ignores a kind it has never heard of", () => {
    // A future event kind must not break a diner's screen mid-meal.
    const steps = buildTimeline(
      [PLACED, event(2, "bill_generated", "2026-09-27T15:00:00Z")],
      { status: "placed", showUpcoming: false },
    );
    expect(steps.map((s) => s.label)).toEqual(["Placed"]);
  });

  it("reads the log in id order, not the order it arrived in", () => {
    const steps = buildTimeline(
      [event(2, "accepted", "2026-09-27T14:32:00Z"), PLACED],
      { status: "accepted", showUpcoming: false },
    );
    expect(steps.map((s) => s.label)).toEqual(["Placed", "Accepted"]);
  });
});
