import type { OrderStatus } from "@prisma/client";

/**
 * The state machine moved to @menu/shared when the board gained role-aware
 * buttons: the browser needs the same table to decide what to draw, and the
 * one thing worse than duplicating it is duplicating it across a network
 * boundary. Re-exported here so the existing call sites and tests are
 * unchanged.
 */
export {
  ORDER_STATUSES,
  ALLOWED_TRANSITIONS,
  canTransition,
  ROLE_TARGETS,
  canRoleSetStatus,
} from "@menu/shared";

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
