/**
 * Who may move an order where.
 *
 * This lives beside the state machine rather than in the API because the
 * board draws its buttons from the same table. A screen that offers "Served"
 * to someone the API will refuse is worse than a screen with no button.
 */

/** Every value of the enum, in declaration order. */
export const ORDER_STATUSES = [
  "placed",
  "accepted",
  "preparing",
  "ready",
  "completed",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Roles a person can hold *within* one business. */
export const STAFF_ROLES = ["kitchen"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Everyone who can reach a business's data: its owner, or its staff. */
export type AccessRole = "owner" | StaffRole;

/**
 * The state machine. Forward skips are deliberate: a kitchen mid-rush that
 * taps Ready on something still marked New should not be told to tap three
 * more times first.
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

/**
 * Which statuses each role may set at all.
 *
 * `completed` is withheld from the kitchen because it is what closes an
 * order for billing — a service act. `cancelled` is withheld because it
 * rewrites a bill. Neither is about trust; both are about which job the
 * person at the pass is doing.
 */
export const ROLE_TARGETS: Record<AccessRole, OrderStatus[]> = {
  owner: [...ORDER_STATUSES],
  kitchen: ["accepted", "preparing", "ready"],
};

/**
 * The intersection, which is the only correct question.
 *
 * Either table alone gives a wrong answer: ROLE_TARGETS allows the kitchen
 * `accepted` without caring that `ready -> accepted` is backwards, and
 * ALLOWED_TRANSITIONS allows `ready -> completed` without caring who asked.
 */
export function canRoleSetStatus(
  role: AccessRole,
  from: OrderStatus,
  to: OrderStatus,
): boolean {
  return (
    ALLOWED_TRANSITIONS[from].includes(to) && ROLE_TARGETS[role].includes(to)
  );
}
