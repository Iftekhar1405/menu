import type { OrderStatus } from "./roles";

/**
 * The live statuses, least advanced first.
 *
 * This is the same list as OPEN_STATUSES in the API, and the same list the
 * derivation trigger walks in SQL. See the warning in
 * apps/api/src/orders/transitions.ts: adding a status here means adding it
 * there too, and the failure is silent.
 */
export const LIFECYCLE_ORDER: OrderStatus[] = [
  "placed",
  "accepted",
  "preparing",
  "ready",
];

/**
 * What an order's status is, given its rounds'.
 *
 * The least advanced live round, because an order is not ready while some
 * part of it has not been started. A table with a ready biryani and a just
 * -ordered chai is a table with something still to do, and the board must
 * show it that way.
 *
 * Terminal rounds are invisible while anything is live: a cancelled chai
 * must not hold an otherwise finished order open, and a completed first
 * round must not make a second round look served.
 *
 * Mirrored in SQL by derive_order_status(). The two are tested against the
 * same matrix; if you change one, change both.
 */
export function deriveOrderStatus(roundStatuses: OrderStatus[]): OrderStatus {
  const live = roundStatuses.filter((s) => LIFECYCLE_ORDER.includes(s));
  if (live.length > 0) {
    return LIFECYCLE_ORDER.find((s) => live.includes(s))!;
  }
  if (roundStatuses.length === 0) return "placed";
  // Every round is terminal. One completed round means food was served and a
  // bill is owed; only an entirely cancelled order is cancelled.
  return roundStatuses.includes("completed") ? "completed" : "cancelled";
}
