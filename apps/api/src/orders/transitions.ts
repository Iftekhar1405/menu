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
 * 20260927110000_order_events and 20261005091000_derive_order_status
 * migrations; for `place_table_round` and for `get_table_order`'s two copies,
 * 20261005093000_place_round_per_round and 20261005094000_rounds_in_payloads
 * respectively, each of which re-creates its function in full and so is where
 * that copy now lives.
 *
 * That it fails silently is not hypothetical: `cancel_table_order` holds a
 * sixth copy that has already drifted. Its open-order lookup reads
 * ('placed', 'preparing', 'ready') and never learned about 'accepted', so a
 * diner cannot cancel an order the counter has accepted but the kitchen has
 * not started — they are told they have no open order. The same gap is in
 * CANCELLABLE_STATUSES in packages/shared/src/enums.ts, which is what stops
 * an owner putting 'accepted' in their cancellation policy.
 *
 * 20261005095000_cancel_per_round left both exactly as they are, on purpose.
 * Whether a diner may still cancel after the counter has accepted is a
 * decision about what diners are allowed to do, not a list that drifted, and
 * it is not one a refactor of that function should make on the way past. It
 * is open as its own question.
 */
export const OPEN_STATUSES: OrderStatus[] = [
  "placed",
  "accepted",
  "preparing",
  "ready",
];
