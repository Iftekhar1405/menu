/**
 * What the dashboard holds, and — more importantly — what it is allowed to
 * make a noise about.
 *
 * The transport underneath is deliberately unreliable in one direction: a
 * Realtime ping may be replayed, may arrive twice, may never arrive at all,
 * and the fallback poll can overlap a delivery already in flight. Every one
 * of those shows up here as the same question — have I seen this id before?
 * — so it is answered once, in a pure function, rather than at each of the
 * four call sites that wake the feed up.
 *
 * Getting it wrong is audible. A double-delivered order chimes twice; a
 * first page treated as new chimes through an entire evening of history.
 */
export interface FeedItem {
  id: number;
  kind: string;
  title: string;
  body: string;
  /** Rendered directly. The UI never parses `title` to recover a fact. */
  data: { dailyNumber?: number; tableLabel?: string };
  orderId: string | null;
  tableId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface Feed {
  /** Newest first. */
  items: FeedItem[];
  unread: number;
  /** The highest id ever merged. What the next catch-up asks for. */
  cursor: number;
}

export const emptyFeed: Feed = { items: [], unread: 0, cursor: 0 };

/**
 * How many notifications are kept in memory.
 *
 * A busy Saturday is a few hundred orders, and a tablet left open for a week
 * would otherwise accumulate all of them. The bell shows recent activity,
 * not an archive.
 */
const MAX_ITEMS = 200;

export interface MergeOptions {
  /** The server's newest id, which may be ahead of anything in `incoming`. */
  cursor: number;
  /**
   * True for the bootstrap read. Its items are merged but never reported
   * fresh: opening the dashboard must not chime through orders that were
   * dealt with hours ago.
   */
  initial: boolean;
}

export function mergeFeed(
  feed: Feed,
  incoming: FeedItem[],
  { cursor, initial }: MergeOptions,
): { feed: Feed; fresh: FeedItem[] } {
  const known = new Set(feed.items.map((i) => i.id));

  // A newer copy of an id we hold is an update, not an arrival — marking
  // something read on another device comes back as exactly that.
  const byId = new Map(feed.items.map((i) => [i.id, i]));
  for (const item of incoming) byId.set(item.id, item);

  const items = [...byId.values()]
    .sort((a, b) => b.id - a.id)
    .slice(0, MAX_ITEMS);

  const fresh = initial ? [] : incoming.filter((i) => !known.has(i.id));

  return {
    feed: {
      items,
      unread: items.filter((i) => i.readAt === null).length,
      // Never backwards: two reads can land out of order, and taking the
      // older one's cursor would re-request rows already merged — which,
      // since they would then be unknown again, would re-chime them.
      cursor: Math.max(feed.cursor, cursor),
    },
    fresh,
  };
}

/**
 * Marks read without waiting for the server.
 *
 * The badge has to clear on tap. A round trip to a database ~400ms away is
 * long enough that the tap reads as having done nothing, and the reconciled
 * server state arrives on the next merge anyway.
 */
export function markReadLocally(feed: Feed, ids: number[]): Feed {
  const target = ids.length > 0 ? new Set(ids) : null;
  const now = new Date().toISOString();

  const items = feed.items.map((i) =>
    i.readAt === null && (target === null || target.has(i.id))
      ? { ...i, readAt: now }
      : i,
  );

  return { ...feed, items, unread: items.filter((i) => i.readAt === null).length };
}

/**
 * How many announced ids to remember, and how many to keep when trimming.
 *
 * Comfortably more than `MAX_ITEMS`, so the memory of what has already
 * chimed always outlives the feed rows that would otherwise look new again.
 * A tablet left open for a week would accumulate these forever otherwise.
 */
const MAX_ANNOUNCED = 1000;
const KEEP_ANNOUNCED = 500;

/**
 * Of these, the ones that have not already been announced — and remembers
 * them, so the next caller gets nothing.
 *
 * `mergeFeed` decides what is new relative to the rows held in state, which
 * is the right question but not a durable answer: React invokes a state
 * updater twice in development under StrictMode, and two refreshes can
 * overlap and carry the same row — more easily now that the kitchen's cursor
 * is deliberately held back over rows that are not visible to it yet. Both
 * produce the same `fresh` list twice, and the result is an order that
 * chimes twice and shows two identical toasts.
 *
 * Announcing is the one effect here that cannot be made idempotent by being
 * repeated correctly — a second chime is a second order as far as the person
 * hearing it is concerned. So the set lives outside React's control flow and
 * answers "has this id ever been announced", which no amount of re-running
 * can change.
 *
 * Mutates `announced` in place: it is a ref, and the whole point is that it
 * survives the render that discovers it.
 */
export function takeUnannounced(
  announced: Set<number>,
  fresh: FeedItem[],
): FeedItem[] {
  const first = fresh.filter((i) => !announced.has(i.id));
  for (const item of first) announced.add(item.id);

  if (announced.size > MAX_ANNOUNCED) {
    // Newest kept: an id old enough to be trimmed is also long gone from
    // `items`, so nothing that could still be re-delivered is forgotten.
    const keep = [...announced].sort((a, b) => b - a).slice(0, KEEP_ANNOUNCED);
    announced.clear();
    for (const id of keep) announced.add(id);
  }

  return first;
}
