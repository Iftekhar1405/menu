import {
  CANCELLATION_REASON_STAFF_LABEL,
  formatMoney,
  type CancellationReason,
} from "@menu/shared";

/**
 * What a notification says, decided in exactly one place.
 *
 * The bell row, the toast and the pushed notification all render the strings
 * written here at emit time rather than each formatting the event
 * themselves. Three renderers describing the same order three slightly
 * different ways is the usual way these systems go wrong, and it is worse
 * than it sounds: staff stop trusting the notification and go back to
 * watching the board, which is the thing this exists to stop.
 */
export type StaffNotificationKind =
  | "order.placed"
  | "order.round_added"
  | "order.cancelled"
  | "order.item_cancelled";

export interface OrderLine {
  name: string;
  quantity: number;
}

export interface OrderRoundSummary {
  tableLabel: string;
  dailyNumber: number;
  currency: string;
  /** Just the new round's lines — not the whole order. */
  lines: OrderLine[];
  /** The new round's money, as a decimal string. */
  total: string;
  /**
   * This table was served and came back inside the owner's window. Changes
   * what the title says, because "New order" for a table the owner served
   * ten minutes ago reads as a different table and sends staff to the wrong
   * one.
   */
  isRunning?: boolean;
}

/**
 * How many dishes a notification names before summarising the rest.
 *
 * A pushed notification gets about two lines on a phone. Listing eleven
 * dishes means the reader sees neither the dishes nor the total, which is
 * the one number that tells them how big the order is.
 */
const MAX_LINES = 3;

export function staffNotificationCopy(
  kind: StaffNotificationKind,
  summary: OrderRoundSummary,
): { title: string; body: string } {
  const title =
    kind === "order.placed"
      ? summary.isRunning
        ? `Ordered again · Table ${summary.tableLabel}`
        : `New order · Table ${summary.tableLabel}`
      : `Added to Table ${summary.tableLabel}`;

  const shown = summary.lines.slice(0, MAX_LINES).map(describeLine);
  const hidden = summary.lines.length - shown.length;
  if (hidden > 0) shown.push(`+${hidden} more`);

  const money = formatMoney(summary.total, summary.currency);
  const body = shown.length > 0 ? `${shown.join(", ")} · ${money}` : money;

  return { title, body };
}

/** "2× Masala Dosa", but just "Filter Coffee" when there is one of them. */
function describeLine(line: OrderLine): string {
  return line.quantity > 1 ? `${line.quantity}× ${line.name}` : line.name;
}

/** The shape `get_table_order` returns, which is what placing a round gives back. */
export interface PlacedOrder {
  id: string;
  status: string;
  dailyNumber: number;
  tableLabel: string;
  currency: string;
  /** Merged into the payload by `place_table_round`. Absent on older rows. */
  isRunning?: boolean;
  items: {
    name: string;
    variant: string | null;
    unitPrice: string;
    quantity: number;
    batch: number;
  }[];
  total: string;
}

/**
 * What just arrived, as distinct from what the table has ordered all evening.
 *
 * A round is appended to whatever open order the table already has, so the
 * returned order contains every batch. Announcing all of it would have the
 * kitchen cook the first round a second time; only the newest batch is new
 * information.
 *
 * Null when there is nothing to announce, which the caller treats as "no
 * notification" rather than an error.
 */
export function summariseNewestRound(
  order: PlacedOrder,
): { kind: StaffNotificationKind; summary: OrderRoundSummary } | null {
  if (order.items.length === 0) return null;

  const newest = Math.max(...order.items.map((i) => i.batch));
  const batch = order.items.filter((i) => i.batch === newest);

  return {
    kind: newest === 1 ? "order.placed" : "order.round_added",
    summary: {
      tableLabel: order.tableLabel,
      dailyNumber: order.dailyNumber,
      currency: order.currency,
      lines: batch.map((i) => ({
        // The variant is what is actually made — a large dosa and a small
        // one are different work.
        name: i.variant ? `${i.name} (${i.variant})` : i.name,
        quantity: i.quantity,
      })),
      total: sumMoney(batch),
      // Only a first batch can be a return: a later round lands on an order
      // that is still open, which means the table never left.
      isRunning: newest === 1 && order.isRunning === true,
    },
  };
}

/**
 * Summed in minor units.
 *
 * Adding prices as floats is how a notification ends up reading
 * "₹330.00000000000006" — visible, and the kind of thing that makes staff
 * distrust every other number on the screen.
 */
function sumMoney(lines: { unitPrice: string; quantity: number }[]): string {
  const minor = lines.reduce(
    (sum, l) => sum + Math.round(Number(l.unitPrice) * 100) * l.quantity,
    0,
  );
  return (minor / 100).toFixed(2);
}


/* ── Cancellations ───────────────────────────────────────────────────────── */

export interface CancelledLine extends OrderLine {
  variant: string | null;
  unitPrice: string;
}

export interface CancellationSummary {
  tableLabel: string;
  dailyNumber: number;
  currency: string;
  /** True when nothing was left, so the order itself is cancelled too. */
  orderCancelled: boolean;
  lines: CancelledLine[];
  reason: CancellationReason;
  remark: string | null;
}

/**
 * How much of a diner's own words a pushed notification carries.
 *
 * Enough to be worth reading on a lock screen, and short enough that it
 * cannot push the dish and the reason off the end. The full remark is on the
 * order card either way.
 */
const MAX_REMARK = 80;

/**
 * A cancellation is not a quieter version of an order — it is the one
 * notification where the kitchen may already be cooking, so it says what to
 * stop making before it says anything else.
 */
export function cancellationNotificationCopy(summary: CancellationSummary): {
  kind: StaffNotificationKind;
  title: string;
  body: string;
} {
  const kind: StaffNotificationKind = summary.orderCancelled
    ? "order.cancelled"
    : "order.item_cancelled";

  const title = summary.orderCancelled
    ? `Order cancelled · Table ${summary.tableLabel}`
    : `Cancelled from Table ${summary.tableLabel}`;

  const shown = summary.lines.slice(0, MAX_LINES).map(describeLine);
  const hidden = summary.lines.length - shown.length;
  if (hidden > 0) shown.push(`+${hidden} more`);

  const parts = [
    ...(shown.length > 0 ? [shown.join(", ")] : []),
    formatMoney(sumMoney(summary.lines), summary.currency),
    CANCELLATION_REASON_STAFF_LABEL[summary.reason],
  ];

  const remark = summary.remark?.trim();
  if (remark) parts.push(`“${truncate(remark, MAX_REMARK)}”`);

  return { kind, title, body: parts.join(" · ") };
}

/** Cuts on a word where it can, and never leaves a dangling space. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
