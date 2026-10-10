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
 * WARNING: this list is written out by hand in five other places, all of them
 * SQL — the `orders_one_open_per_table` unique index, `place_table_round`'s
 * lookup of the order to append to, `get_table_order` (twice: its WHERE
 * clause and the ORDER BY that puts a table's open order ahead of its last
 * closed one), and `derive_order_status`, which walks it in order to pick the
 * least advanced live round. Adding a status here without adding it there
 * does not fail loudly: the index silently stops constraining accepted
 * orders, a table ends up with two open orders and two bills, and the
 * derivation quietly treats the new status as terminal. See the
 * 20260927110000_order_events, 20260928000000_order_round_fixes and
 * 20261005091000_derive_order_status migrations.
 */
export const OPEN_STATUSES: OrderStatus[] = [
  "placed",
  "accepted",
  "preparing",
  "ready",
];
