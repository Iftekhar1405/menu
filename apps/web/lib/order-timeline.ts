/**
 * Turning an order's event log into the steps a screen draws.
 *
 * Kept out of JSX deliberately. The interesting decisions here — which stage
 * is current, which never happened, how far apart two of them were — are the
 * kind that need a test each, and they are the same decisions on the diner's
 * phone and the owner's board.
 */

export type OrderStatus =
  | "placed"
  | "accepted"
  | "preparing"
  | "ready"
  | "completed"
  | "cancelled";

export interface OrderEvent {
  id: number;
  kind: string;
  /** ISO 8601, UTC. */
  at: string;
  data?: { batch?: number; items?: { name: string; quantity: number }[] } | null;
}

export interface TimelineStep {
  key: string;
  kind: string;
  label: string;
  /** ISO of when it happened; null for a stage still to come. */
  at: string | null;
  state: "done" | "current" | "upcoming";
  /** Milliseconds since the previous step that actually happened. */
  sincePreviousMs: number | null;
  /** "3 items" on a round, null on a bare status change. */
  detail: string | null;
}

/** The happy path, in the order Postgres sorts the enum. */
const FLOW: OrderStatus[] = ["placed", "accepted", "preparing", "ready", "completed"];

const LABELS: Record<OrderStatus, string> = {
  placed: "Placed",
  accepted: "Accepted",
  preparing: "Being made",
  ready: "Ready",
  completed: "Served",
  cancelled: "Cancelled",
};

function isStatus(kind: string): kind is OrderStatus {
  return kind in LABELS;
}

export function buildTimeline(
  events: OrderEvent[],
  options: { status: OrderStatus; showUpcoming: boolean },
): TimelineStep[] {
  // By id, not by `at`. Accepting an order and starting it 200ms apart must
  // render in the order they happened, and the server may hand these back in
  // any order a future query planner likes.
  const ordered = [...events].sort((a, b) => a.id - b.id);

  // Anything this version has never heard of is dropped rather than rendered
  // as a blank row. A future event kind must not break a diner's screen.
  const known = ordered.filter((e) => isStatus(e.kind) || e.kind === "round_added");

  const lastStatusId = known.reduce(
    (id, e) => (isStatus(e.kind) ? e.id : id),
    null as number | null,
  );

  const steps: TimelineStep[] = [];
  let previousAt: number | null = null;

  for (const e of known) {
    const at = new Date(e.at).getTime();
    const label = isStatus(e.kind)
      ? LABELS[e.kind]
      : `Round ${e.data?.batch ?? "?"} added`;

    steps.push({
      key: `e${e.id}`,
      kind: e.kind,
      label,
      at: e.at,
      // A round is a fact about the order, never the thing it is waiting on,
      // so only a status event is ever current.
      state: e.id === lastStatusId ? "current" : "done",
      sincePreviousMs: previousAt === null ? null : at - previousAt,
      detail: describeRound(e),
    });

    previousAt = at;
  }

  if (!options.showUpcoming) return steps;

  // Nothing further is coming for an order that is finished either way, and
  // showing "Ready" as pending under "Cancelled" would be a small lie.
  if (options.status === "completed" || options.status === "cancelled") return steps;

  // Only stages *after* the current one. A stage the kitchen skipped past is
  // in neither list, which is exactly right: it is not history and it is not
  // going to happen.
  const from = FLOW.indexOf(options.status);
  for (const stage of FLOW.slice(from + 1)) {
    steps.push({
      key: `u-${stage}`,
      kind: stage,
      label: LABELS[stage],
      at: null,
      state: "upcoming",
      sincePreviousMs: null,
      detail: null,
    });
  }

  return steps;
}

/** "3 items" — the size of a round, for the steps that carry one. */
function describeRound(e: OrderEvent): string | null {
  const items = e.data?.items;
  if (!items || items.length === 0) return null;
  const count = items.reduce((n, i) => n + i.quantity, 0);
  return count === 1 ? "1 item" : `${count} items`;
}

/**
 * "8:32pm".
 *
 * en-US rather than the visitor's locale: this is a 12-hour clock beside a
 * short label in a narrow column, and a locale that renders "20:32" or pads
 * the hour changes the column width under it. `timeZone` exists for tests —
 * in the browser it is omitted, which is the device's own zone, which is the
 * restaurant's.
 */
export function formatClock(iso: string, timeZone?: string): string {
  const text = new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
  return text.replace(/\s*([AP])M$/i, (_, meridiem: string) =>
    `${meridiem.toLowerCase()}m`,
  );
}

/**
 * "+2m" — how long the previous stage took.
 *
 * Rounds down to whole minutes but never to zero: a stage that took forty
 * seconds reads "+<1m", because "+0m" invites the reader to believe two
 * things happened at once.
 */
export function formatGap(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "+<1m";
  if (minutes < 60) return `+${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `+${hours}h` : `+${hours}h ${rest}m`;
}
