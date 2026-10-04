import type { Prisma } from "@prisma/client";
import type { AccessRole } from "@menu/shared";

/**
 * The statuses that put an order on the kitchen's board.
 *
 * Deliberately a list of its own rather than `ROLE_TARGETS.kitchen`, which
 * is the near-identical list of statuses the kitchen may *set*. The two
 * answer different questions and are free to diverge: `accepted` has already
 * left the kitchen's buttons (the owner accepts, the kitchen cooks), and the
 * day it leaves ROLE_TARGETS too, borrowing that list here would silently
 * hide every accepted order's notification.
 *
 * `completed` is absent on purpose. An owner may take an order straight from
 * `placed` to `completed` — the state machine allows it — and an order that
 * never needed cooking is not news for the kitchen.
 */
export const KITCHEN_BOARD: string[] = ["accepted", "preparing", "ready"];

/**
 * Which stored notifications a reader is allowed to see, and when.
 *
 * Owners see their venue's whole feed. The kitchen's is narrower in two
 * ways, and both are about the same thing: a notification they cannot act
 * on is not information, it is a chime that teaches them to ignore chimes.
 *
 *  1. Nothing from before they joined — see `since` below.
 *  2. Nothing about an order nobody has accepted yet.
 *
 * (2) matters because an order sits in `placed` until someone front of
 * house takes it on, which is a counter decision, not a kitchen one. The
 * kitchen's board starts at Accepted for exactly this reason; the bell has
 * to agree with the board, or the two surfaces disagree about what the
 * kitchen is supposed to be cooking.
 *
 * Whether an order reached the kitchen is read from `order_events`, not from
 * the order's current status. An order cancelled while it was being cooked is
 * `cancelled` now but was on the board a minute ago, and "stop making this"
 * is the single most important notification the kitchen ever receives — a
 * test against the current status would hide it at precisely the wrong
 * moment.
 */
export function visibleTo(
  role: AccessRole,
  businessId: string,
  since: Date | null,
): Prisma.NotificationWhereInput {
  const window: Prisma.NotificationWhereInput = {
    businessId,
    ...(since && { createdAt: { gte: since } }),
  };

  if (role === "owner") return window;

  return {
    ...window,
    OR: [
      // No order to gate on. Nothing emits one of these today; allowing it
      // is the safer default, because the alternative is a venue-wide
      // announcement silently reaching nobody but the owner.
      { orderId: null },
      { order: { events: { some: { kind: { in: KITCHEN_BOARD } } } } },
    ],
  };
}

/**
 * Notifications this reader cannot see *yet*, but will.
 *
 * Only `placed` qualifies: an order in any later status has been accepted,
 * and one that was cancelled out of `placed` never will be, so it must not
 * hold the cursor back for the rest of the evening.
 *
 * Null for owners, who have no such rows.
 */
export function pendingFor(
  role: AccessRole,
  businessId: string,
  since: Date | null,
): Prisma.NotificationWhereInput | null {
  if (role === "owner") return null;
  return {
    businessId,
    ...(since && { createdAt: { gte: since } }),
    order: { is: { status: "placed" } },
  };
}

/**
 * The id the client should ask from next time.
 *
 * Normally the newest id that exists — a page truncated by `take` must not
 * leave the cursor ahead of rows the client would then never request again.
 *
 * The kitchen needs one more rule. Its feed is the only one where a row can
 * become visible *after* it was written: the notification for a new order is
 * hidden until someone accepts it. The client only ever asks for ids above
 * its cursor, so advancing past a still-hidden row would bury it for good —
 * the kitchen would be told about the order when it was placed (never) and
 * not when it was accepted (too late to matter).
 *
 * So the cursor stops just below the oldest row still waiting on an accept.
 * The client re-receives the handful of visible rows above it on each poll
 * and merges them by id without re-chiming, which is a few hundred bytes to
 * guarantee an order is never silently dropped.
 */
export function cursorFor(
  newestVisibleId: number,
  oldestPendingId: number | null,
): number {
  if (oldestPendingId === null) return newestVisibleId;
  return Math.min(newestVisibleId, oldestPendingId - 1);
}
