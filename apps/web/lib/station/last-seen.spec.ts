import { describe, expect, it } from "vitest";
import { lastSeenLabel } from "./last-seen";

const NOW = new Date("2026-10-04T16:00:00.000Z");

/**
 * The station polls every ten seconds, so the risk in this function is
 * entirely at its branch boundaries (minute → hour → day, plus the null
 * case) — a fixture that only ever lands mid-range would let an off-by-one
 * at any of those edges through. Each boundary below is pinned on both
 * sides, with one mid-range case per branch to confirm the arithmetic (not
 * just the cutoff) is right, and the singular/plural wording at the "1 x
 * ago" edge of each unit.
 */
describe("lastSeenLabel", () => {
  it("calls a station seen 59 seconds ago online", () => {
    // Just inside the minute window: a working machine, reassurance, not a
    // number.
    expect(lastSeenLabel("2026-10-04T15:59:01.000Z", NOW)).toBe("Online");
  });

  it("stops calling it online the instant a full minute has passed", () => {
    // Exactly 60s — the first tick that must NOT read "Online".
    expect(lastSeenLabel("2026-10-04T15:59:00.000Z", NOW)).toBe("Last seen 1 minute ago");
  });

  it("counts the minutes while it is plausibly just slow", () => {
    expect(lastSeenLabel("2026-10-04T15:52:00.000Z", NOW)).toBe("Last seen 8 minutes ago");
  });

  it("stays in minutes at 59 minutes, one tick before the hour boundary", () => {
    expect(lastSeenLabel("2026-10-04T15:01:00.000Z", NOW)).toBe("Last seen 59 minutes ago");
  });

  it("switches to hours the instant a full hour has passed", () => {
    expect(lastSeenLabel("2026-10-04T15:00:00.000Z", NOW)).toBe("Last seen 1 hour ago");
  });

  it("counts the hours once minutes stop being useful", () => {
    expect(lastSeenLabel("2026-10-04T12:00:00.000Z", NOW)).toBe("Last seen 4 hours ago");
  });

  it("stays in hours at 23 hours, one tick before the day boundary", () => {
    expect(lastSeenLabel("2026-10-03T17:00:00.000Z", NOW)).toBe("Last seen 23 hours ago");
  });

  it("switches to days the instant a full day has passed", () => {
    expect(lastSeenLabel("2026-10-03T16:00:00.000Z", NOW)).toBe("Last seen 1 day ago");
  });

  it("says plainly that a machine has never been seen", () => {
    // A station created and never opened again. "Last seen never" is a
    // riddle; this is the state an owner most needs to act on.
    expect(lastSeenLabel(null, NOW)).toBe("Never connected");
  });
});
