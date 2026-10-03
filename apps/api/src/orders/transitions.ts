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
  "paid",
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
 *
 * Statuses meaning *finished* (`completed`, `paid`) are likewise listed by
 * hand in `place_table_round`, `get_table_order` and `get_ratable_order` —
 * see the 20261003000100_bill_payment migration.
 */
export const OPEN_STATUSES: OrderStatus[] = [
  "placed",
  "accepted",
  "preparing",
  "ready",
];

/** Served or settled — the order is over. Mirrors the SQL lists above. */
export const FINISHED_STATUSES: OrderStatus[] = ["completed", "paid", "cancelled"];

/**
 * What staff are allowed to move an order to.
 *
 * Forward skips are deliberate. The board only ever offers the next step, but
 * a kitchen mid-rush that taps Ready on something still marked New should not
 * be told to tap three more times first.
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  placed: ["accepted", "preparing", "ready", "completed", "paid", "cancelled"],
  accepted: ["preparing", "ready", "completed", "paid", "cancelled"],
  preparing: ["ready", "completed", "paid", "cancelled"],
  ready: ["completed", "paid", "cancelled"],
  // Served food still has to be paid for; that is the only way forward.
  completed: ["paid"],
  // A finished order stays finished. Reopening one would put two open orders
  // on a table that has since seated new diners.
  paid: [],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
