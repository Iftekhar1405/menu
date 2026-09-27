import type { OrderStatus } from "@prisma/client";

/**
 * The order state machine, in one place.
 *
 * Lifted out of the service so it can be asserted directly. The rules are
 * short enough to look obvious and subtle enough to get wrong — "can a ready
 * order go back to preparing" has a right answer, and it is the kind of thing
 * a refactor quietly changes.
 */

/** Every value of the enum, in declaration order. */
export const ORDER_STATUSES = [
  "placed",
  "accepted",
  "preparing",
  "ready",
  "completed",
  "cancelled",
] as const satisfies readonly OrderStatus[];

/**
 * What counts as an order still in play.
 *
 * WARNING: this list is written out by hand in four other places, all of them
 * SQL — the `orders_one_open_per_table` unique index, `place_table_round`'s
 * lookup of the order to append to, and `get_table_order`'s WHERE clause.
 * Adding a status here without adding it there does not fail loudly: the
 * index silently stops constraining accepted orders, and a table ends up with
 * two open orders and two bills. See the 20260927110000_order_events
 * migration.
 */
export const OPEN_STATUSES: OrderStatus[] = [
  "placed",
  "accepted",
  "preparing",
  "ready",
];

/**
 * What staff are allowed to move an order to.
 *
 * Forward skips are deliberate. The board only ever offers the next step, but
 * a kitchen mid-rush that taps Ready on something still marked New should not
 * be told to tap three more times first.
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  placed: ["accepted", "preparing", "ready", "completed", "cancelled"],
  accepted: ["preparing", "ready", "completed", "cancelled"],
  preparing: ["ready", "completed", "cancelled"],
  ready: ["completed", "cancelled"],
  // A finished order stays finished. Reopening one would put two open orders
  // on a table that has since seated new diners.
  completed: [],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
