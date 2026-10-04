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
 * All four columns always render. A kitchen that cannot see what is sitting
 * in Ready cannot tell whether the pass is backing up — the column is
 * information, the button is the permission, and only the button is withheld.
 */
export function columnsFor(role: AccessRole): BoardColumn[] {
  return COLUMNS.map((c) =>
    canRoleSetStatus(role, c.status, c.next)
      ? c
      : { status: c.status, title: c.title },
  );
}

/** Belt to the API's braces: it already omits every price for kitchen. */
export function showsMoney(role: AccessRole): boolean {
  return role === "owner";
}
