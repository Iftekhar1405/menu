import { describe, expect, it } from "vitest";
import { jobsForEvent } from "./printing";

describe("jobsForEvent", () => {
  it("turns an accepted round into a token slip and a kitchen ticket", () => {
    expect(jobsForEvent("round.accepted")).toEqual(["token", "kitchen"]);
  });

  it("turns a closed order into a bill", () => {
    // Order-level events are bare status strings with round_id null.
    expect(jobsForEvent("completed")).toEqual(["bill"]);
  });

  it("prints nothing for the statuses in between", () => {
    // A ticket per status change would bury the pass in paper.
    expect(jobsForEvent("round.preparing")).toEqual([]);
    expect(jobsForEvent("round.ready")).toEqual([]);
  });

  it("prints nothing for a cancellation", () => {
    // A void slip for a round the kitchen already holds is a real feature
    // and a deliberate omission — see "Not built" in the spec.
    expect(jobsForEvent("round.cancelled")).toEqual([]);
    expect(jobsForEvent("cancelled")).toEqual([]);
  });

  it("prints nothing for an event it has never heard of", () => {
    // New event kinds get added by other features. Silence is the only safe
    // default: the alternative is a station printing something nobody designed.
    expect(jobsForEvent("round_added")).toEqual([]);
    expect(jobsForEvent("placed")).toEqual([]);
  });
});
