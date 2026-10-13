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

/**
 * The one move this role may make on a round in this state, or nothing.
 *
 * Drawn from the same COLUMNS table the columns are, so a label can never
 * disagree between the column header and the button inside a card.
 */
export function nextActionFor(
  role: AccessRole,
  status: OrderStatus,
): { status: OrderStatus; label: string } | null {
  const column = COLUMNS.find((c) => c.status === status);
  if (!column) return null;
  if (!canRoleSetStatus(role, status, column.next)) return null;
  return { status: column.next, label: column.nextLabel };
}

/**
 * What a round's status chip says.
 *
 * The four live ones borrow the column titles, so a chip reading "Being made"
 * can never sit in a column headed something else. The two terminal statuses
 * have no column of their own — a card leaves the board when the whole order
 * reaches them — but a single finished round inside a live order still has to
 * say what it is.
 */
export function statusLabel(status: OrderStatus): string {
  const column = COLUMNS.find((c) => c.status === status);
  if (column) return column.title;
  return status === "completed" ? "Served" : "Cancelled";
}

/** Belt to the API's braces: it already omits every price for kitchen. */
export function showsMoney(role: AccessRole): boolean {
  return role === "owner";
}
