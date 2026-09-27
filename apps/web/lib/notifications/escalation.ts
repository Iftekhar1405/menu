/**
 * Keeps chiming for an order nobody has acknowledged.
 *
 * One chime in a room with an extractor fan running is a missed order, so a
 * single alert is not enough. An alert that never gives up is worse: the
 * tablet gets muted, and then every future order is missed too. So this
 * escalates a fixed number of times and then stops, and the cap is a
 * property of the array below rather than a condition someone has to get
 * right.
 *
 * Client-side, which means it only escalates while a tab is alive. Waking a
 * closed device repeatedly is a server-side job and a different feature; the
 * seam is here, the code is not.
 */
export const ESCALATION_STEPS_MS = [30_000, 90_000] as const;

export interface Escalation {
  /** Begin escalating for a notification, if it is not already armed. */
  arm(id: number): void;
  acknowledge(id: number): void;
  /** Opening the board acknowledges everything on it. */
  acknowledgeAll(): void;
  /** Unmount. A timer that outlives the component fires into a dead tree. */
  stop(): void;
}

export function createEscalation({
  onRealert,
  steps = ESCALATION_STEPS_MS,
}: {
  onRealert: (id: number) => void;
  steps?: readonly number[];
}): Escalation {
  const armed = new Map<number, ReturnType<typeof setTimeout>[]>();

  function disarm(id: number): void {
    for (const timer of armed.get(id) ?? []) clearTimeout(timer);
    armed.delete(id);
  }

  return {
    arm(id) {
      // Two deliveries of one order — a replayed ping overlapping a poll —
      // must not stack two chains onto the same ticket.
      if (armed.has(id)) return;

      // Every step is scheduled up front from arm-time, so a slow callback
      // cannot push the later ones out, and the chain has no way to extend
      // itself past the last one.
      armed.set(
        id,
        steps.map((delay) => setTimeout(() => onRealert(id), delay)),
      );
    },

    acknowledge(id) {
      disarm(id);
    },

    acknowledgeAll() {
      for (const id of [...armed.keys()]) disarm(id);
    },

    stop() {
      for (const id of [...armed.keys()]) disarm(id);
    },
  };
}
