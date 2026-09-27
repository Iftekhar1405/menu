import { describe, expect, it } from "vitest";
import { relativeTime } from "./relative-time";

const NOW = new Date("2026-09-27T12:00:00.000Z").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A kitchen reads "4 min" and knows whether it is late. It cannot do
 * anything with "12:04", which requires knowing the current time and doing
 * the subtraction while holding a pan.
 */
describe("relativeTime", () => {
  it("calls the last half-minute 'Just now'", () => {
    expect(relativeTime(ago(20 * SECOND), NOW)).toBe("Just now");
  });

  it("counts whole minutes", () => {
    expect(relativeTime(ago(4 * MINUTE), NOW)).toBe("4 min");
  });

  it("rounds down, so nothing ever looks older than it is", () => {
    expect(relativeTime(ago(4 * MINUTE + 59 * SECOND), NOW)).toBe("4 min");
  });

  it("switches to hours past an hour", () => {
    expect(relativeTime(ago(2 * HOUR), NOW)).toBe("2 hr");
  });

  it("switches to days past a day", () => {
    expect(relativeTime(ago(3 * DAY), NOW)).toBe("3 d");
  });

  it("does not show a negative age when a clock is slightly ahead", () => {
    // Server and tablet clocks disagree by seconds routinely; "-1 min"
    // reads as a bug in the order, not in the clock.
    expect(relativeTime(ago(-5 * SECOND), NOW)).toBe("Just now");
  });

  it("says nothing useful rather than NaN for an unparseable time", () => {
    expect(relativeTime("not a date", NOW)).toBe("");
  });
});
