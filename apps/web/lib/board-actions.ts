import { canRoleSetStatus, type AccessRole, type OrderStatus } from "@menu/shared";

export interface BoardColumn {
  status: OrderStatus;
  title: string;
  next?: OrderStatus;
  nextLabel?: string;
}

const COLUMNS: Required<BoardColumn>[] = [
  { status: "placed",    title: "New",        next: "accepted",  nextLabel: "Accept" },
  { status: "accepted",  title: "Accepted",   next: "preparing", nextLabel: "Start" },
  { status: "preparing", title: "Being made", next: "ready",     nextLabel: "Ready" },
  { status: "ready",     title: "Ready",      next: "completed", nextLabel: "Served" },
];

/**
 * Where each role's board begins.
 *
 * An order sits in `placed` until someone front-of-house takes it on. That is
 * a counter decision — is the table really waiting, can we honour it now — not
 * a kitchen one, and a pass crowded with orders nobody has accepted yet is
 * noise the kitchen cannot act on. So the kitchen's board opens at Accepted:
 * by the time a ticket appears, it is theirs to cook.
 *
 * Owners keep New, because somebody has to work it.
 */
const FIRST_COLUMN: Record<AccessRole, OrderStatus> = {
  owner: "placed",
  kitchen: "accepted",
};

/**
 * Every column from the role's starting point onward renders, including ones
 * it cannot action. A kitchen that cannot see what is sitting in Ready cannot
 * tell whether the pass is backing up — past the starting point the column is
 * information, the button is the permission, and only the button is withheld.
 */
export function columnsFor(role: AccessRole): BoardColumn[] {
  const from = COLUMNS.findIndex((c) => c.status === FIRST_COLUMN[role]);
  return COLUMNS.slice(from === -1 ? 0 : from).map((c) =>
    canRoleSetStatus(role, c.status, c.next)
      ? c
      : { status: c.status, title: c.title },
  );
}

/** Belt to the API's braces: it already omits every price for kitchen. */
export function showsMoney(role: AccessRole): boolean {
  return role === "owner";
}
