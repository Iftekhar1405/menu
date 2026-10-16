import {
  canRoleSetStatus,
  deriveOrderStatus,
  type AccessRole,
  type OrderStatus,
} from "@menu/shared";

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

/**
 * Which column a card belongs in, from its rounds — or null for a card this
 * role's board does not show at all.
 *
 * Not simply `order.status`. That is derived from *every* round, and the
 * kitchen's board does not start at the first one: a table whose biryani is
 * being made and whose just-added chai is still `placed` derives, as an
 * order, to `placed`, which is no column on a kitchen board. The card would
 * vanish mid-cook, taking the dish they are actually cooking with it.
 *
 * So the lane is the derivation over the rounds this role's board shows. For
 * an owner that is all of them, which is `order.status` by definition. For
 * the kitchen it leaves out rounds nobody has accepted yet — the chai's own
 * Accept button still renders inside the card, but an order whose only round
 * is unaccepted stays off their board entirely, because accepting is a
 * counter decision and not a kitchen one.
 */
export function columnFor(
  role: AccessRole,
  roundStatuses: OrderStatus[],
): OrderStatus | null {
  const start = COLUMNS.findIndex((c) => c.status === FIRST_COLUMN[role]);

  // A terminal round is in no column at all, but it stays in the reckoning:
  // the derivation is what decides whether anything is still live, and a
  // table whose rounds are all finished belongs on nobody's board.
  const mine = roundStatuses.filter((s) => {
    const i = COLUMNS.findIndex((c) => c.status === s);
    return i === -1 || i >= start;
  });
  if (mine.length === 0) return null;

  const status = deriveOrderStatus(mine);
  return COLUMNS.some((c) => c.status === status) ? status : null;
}

/** Belt to the API's braces: it already omits every price for kitchen. */
export function showsMoney(role: AccessRole): boolean {
  return role === "owner";
}
