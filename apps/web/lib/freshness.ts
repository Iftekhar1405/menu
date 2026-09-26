/**
 * Which of several in-flight reads is still worth believing.
 *
 * A screen that polls and also updates optimistically has three ways to show
 * the user something that was true a moment ago and is not true now:
 *
 *   1. A read issued *before* a mutation resolves *after* it, overwriting the
 *      optimistic state with data from before the change.
 *   2. A read issued *during* a mutation resolves after it, having been
 *      answered by the server before the write landed — same result.
 *   3. Two reads are in flight and the network delivers them out of order,
 *      so an older snapshot lands on top of a newer one.
 *
 * On the order board any of these made a card snap back to New for up to five
 * seconds after staff tapped Start, then jump forward again on the next poll.
 * All three are the same mistake — applying a response without asking whether
 * it is still current — so all three are answered here rather than at each
 * call site.
 *
 *   const token = fresh.begin();
 *   const data = await get();
 *   if (!fresh.accepts(token)) return;   // something newer happened
 *   setState(data);
 *
 *   const done = fresh.mutating();
 *   try { await patch(); } finally { done(); await reload(); }
 */
export interface Freshness {
  /** Stamp a read that is about to go out. */
  begin(): number;
  /** Should this read's response be applied? Accepting one retires it. */
  accepts(token: number): boolean;
  /**
   * Mark a write as in flight. No read is trusted until the returned
   * callback is invoked, and every read still in flight at that moment is
   * retired — it was answered before the write landed.
   */
  mutating(): () => void;
}

export function createFreshness(): Freshness {
  let issued = 0;
  let applied = 0;
  let staleThrough = 0;
  let pending = 0;

  return {
    begin() {
      return ++issued;
    },

    accepts(token) {
      // Mid-write, the server's answer is a coin flip: it may or may not
      // include the change. Neither is worth overwriting the optimistic
      // state with.
      if (pending > 0) return false;
      if (token <= staleThrough) return false;
      if (token <= applied) return false;
      applied = token;
      return true;
    },

    mutating() {
      pending++;
      let settled = false;
      return () => {
        // Idempotent: a caller that ends the same write twice — a retry
        // path, say — must not let the count fall below zero and re-admit
        // stale reads.
        if (settled) return;
        settled = true;
        pending--;
        // Only the last write outstanding draws the line. Two members of
        // staff working two orders should not retire each other's reads
        // early.
        if (pending === 0) staleThrough = issued;
      };
    },
  };
}
