import { describe, expect, it } from "vitest";
import { createFreshness } from "./freshness";

/**
 * The bug this exists to prevent, in one sentence: an order board that polls
 * every five seconds and also updates optimistically will, often enough to be
 * noticed every service, show a card snap back to its old status for up to
 * five seconds before moving forward again.
 *
 * Each test below is one of the orderings that produced it.
 */
describe("createFreshness", () => {
  it("accepts a read when nothing has happened since it was issued", () => {
    const f = createFreshness();
    expect(f.accepts(f.begin())).toBe(true);
  });

  it("drops a read issued before a write", () => {
    const f = createFreshness();

    const poll = f.begin(); // the poll goes out
    const done = f.mutating(); // staff tap Start
    done(); // the write lands

    expect(f.accepts(poll)).toBe(false);
  });

  it("drops a read issued during a write", () => {
    const f = createFreshness();

    const done = f.mutating();
    // The poll interval fires mid-write. The server may answer this from
    // before the write commits.
    const poll = f.begin();
    done();

    expect(f.accepts(poll)).toBe(false);
  });

  it("drops a read that resolves while a write is still in flight", () => {
    const f = createFreshness();

    const poll = f.begin();
    f.mutating();

    expect(f.accepts(poll)).toBe(false);
  });

  it("accepts the read issued after the write settles", () => {
    const f = createFreshness();

    const done = f.mutating();
    f.begin();
    done();

    expect(f.accepts(f.begin())).toBe(true);
  });

  it("drops a read that resolves out of order behind a newer one", () => {
    const f = createFreshness();

    const first = f.begin();
    const second = f.begin();

    // A slow network delivers the second response first.
    expect(f.accepts(second)).toBe(true);
    expect(f.accepts(first)).toBe(false);
  });

  it("drops a read that has already been applied", () => {
    const f = createFreshness();
    const read = f.begin();

    expect(f.accepts(read)).toBe(true);
    expect(f.accepts(read)).toBe(false);
  });

  it("waits for the last of several overlapping writes", () => {
    const f = createFreshness();

    // Two members of staff working two orders on two devices.
    const first = f.mutating();
    const second = f.mutating();

    const poll = f.begin();
    first();
    // Still one write outstanding, so nothing is trusted yet.
    expect(f.accepts(poll)).toBe(false);

    second();
    expect(f.accepts(f.begin())).toBe(true);
  });

  it("ignores a write that is ended twice", () => {
    const f = createFreshness();

    const done = f.mutating();
    done();
    done();

    // The second call must not have driven the count negative, which would
    // re-admit reads while a later write is in flight.
    f.mutating();
    expect(f.accepts(f.begin())).toBe(false);
  });

  it("keeps working across a long service", () => {
    const f = createFreshness();

    for (let i = 0; i < 100; i++) {
      const stale = f.begin();
      const done = f.mutating();
      done();
      expect(f.accepts(stale)).toBe(false);
      expect(f.accepts(f.begin())).toBe(true);
    }
  });
});
