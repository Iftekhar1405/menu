import { describe, expect, it } from "vitest";
import { emptyFeed, mergeFeed, markReadLocally, type FeedItem } from "./feed";

function item(id: number, over: Partial<FeedItem> = {}): FeedItem {
  return {
    id,
    kind: "order.placed",
    title: `New order · Table ${id}`,
    body: "2× Dosa · ₹450",
    data: { tableLabel: String(id), dailyNumber: id },
    orderId: `order-${id}`,
    tableId: `table-${id}`,
    createdAt: new Date(Date.UTC(2026, 8, 27, 12, id)).toISOString(),
    readAt: null,
    ...over,
  };
}

describe("mergeFeed", () => {
  it("reports the first load's items as not fresh", () => {
    // Opening the dashboard must not chime through an entire evening of
    // orders that were dealt with hours ago.
    const { fresh, feed } = mergeFeed(emptyFeed, [item(3), item(2), item(1)], {
      cursor: 3,
      initial: true,
    });
    expect(fresh).toEqual([]);
    expect(feed.items).toHaveLength(3);
  });

  it("reports genuinely new items as fresh", () => {
    const first = mergeFeed(emptyFeed, [item(1)], { cursor: 1, initial: true });
    const { fresh } = mergeFeed(first.feed, [item(2)], { cursor: 2, initial: false });
    expect(fresh.map((f) => f.id)).toEqual([2]);
  });

  it("does not re-report an item it already has", () => {
    // A ping can be replayed, and a fallback poll can overlap an in-flight
    // socket delivery. Either would chime twice for one order.
    const first = mergeFeed(emptyFeed, [item(1)], { cursor: 1, initial: true });
    const second = mergeFeed(first.feed, [item(2)], { cursor: 2, initial: false });
    const { fresh, feed } = mergeFeed(second.feed, [item(2)], {
      cursor: 2,
      initial: false,
    });
    expect(fresh).toEqual([]);
    expect(feed.items).toHaveLength(2);
  });

  it("keeps the newest first regardless of what order they arrived in", () => {
    const { feed } = mergeFeed(emptyFeed, [item(1), item(3), item(2)], {
      cursor: 3,
      initial: true,
    });
    expect(feed.items.map((i) => i.id)).toEqual([3, 2, 1]);
  });

  it("never moves the cursor backwards", () => {
    // Two reads can land out of order. Accepting the older one's cursor
    // would re-request rows already merged, and re-chime them.
    const first = mergeFeed(emptyFeed, [item(5)], { cursor: 5, initial: true });
    const { feed } = mergeFeed(first.feed, [], { cursor: 2, initial: false });
    expect(feed.cursor).toBe(5);
  });

  it("counts unread from the items it holds", () => {
    const { feed } = mergeFeed(
      emptyFeed,
      [item(1), item(2, { readAt: new Date().toISOString() })],
      { cursor: 2, initial: true },
    );
    expect(feed.unread).toBe(1);
  });

  it("prefers the newer copy of an item it already had", () => {
    // Marking read on another device arrives as the same id with readAt set.
    const first = mergeFeed(emptyFeed, [item(1)], { cursor: 1, initial: true });
    const { feed } = mergeFeed(first.feed, [item(1, { readAt: "2026-09-27T12:30:00.000Z" })], {
      cursor: 1,
      initial: false,
    });
    expect(feed.items[0]!.readAt).not.toBeNull();
    expect(feed.unread).toBe(0);
  });

  it("caps how much it holds so a long shift cannot grow without bound", () => {
    const many = Array.from({ length: 260 }, (_, i) => item(i + 1));
    const { feed } = mergeFeed(emptyFeed, many, { cursor: 260, initial: true });
    expect(feed.items.length).toBeLessThanOrEqual(200);
    // The cap drops the oldest, never the newest.
    expect(feed.items[0]!.id).toBe(260);
  });
});

describe("markReadLocally", () => {
  it("clears the unread count without waiting for the server", () => {
    // The badge has to go out on tap. A round trip to a database ~400ms
    // away is long enough to feel like the tap did nothing.
    const { feed } = mergeFeed(emptyFeed, [item(1), item(2)], {
      cursor: 2,
      initial: true,
    });
    const after = markReadLocally(feed, [1, 2]);
    expect(after.unread).toBe(0);
  });

  it("marks everything when no ids are named", () => {
    const { feed } = mergeFeed(emptyFeed, [item(1), item(2)], {
      cursor: 2,
      initial: true,
    });
    expect(markReadLocally(feed, []).unread).toBe(0);
  });

  it("leaves unnamed notifications alone", () => {
    const { feed } = mergeFeed(emptyFeed, [item(1), item(2)], {
      cursor: 2,
      initial: true,
    });
    expect(markReadLocally(feed, [1]).unread).toBe(1);
  });
});
