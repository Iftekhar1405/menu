import { EscPos } from "./bytes";
import { centre, columnsFor, rule, twoCol, wrap, type PaperWidth } from "./layout";

/**
 * What the customer is handed when their round is accepted.
 *
 * No dishes and no prices: this is a claim check, and the kitchen's copy is
 * where the food is listed. `token` is Order.dailyNumber, so the slip in a
 * hand and the ticket on the pass carry the same number.
 */
export interface TokenTicket {
  kind: "token";
  businessName: string;
  token: number;
  /** Round number within the order. "Round N" is printed only when > 1. */
  seq: number;
  tableLabel: string;
  /** ISO 8601. */
  at: string;
}

/**
 * What goes on the pass.
 *
 * `items` is THIS round's lines and nothing else: the round is the unit of
 * cooking, and a ticket that reprinted round 1 would have the kitchen make
 * the biryani twice. Identical dishes are not merged for the same reason —
 * the bill merges them because the customer ordered three; the kitchen
 * ticket does not because three is what has to be cooked.
 *
 * No prices. The kitchen role sees no money anywhere else in this product
 * and paper is not an exception.
 */
export interface KitchenTicket {
  kind: "kitchen";
  token: number;
  tableLabel: string;
  kotNumber: number;
  seq: number;
  isRunning: boolean;
  /**
   * The ORDER's note, not the line's. `order_items` has no note column;
   * what a diner can write applies to the whole order.
   */
  note: string | null;
  at: string;
  items: { quantity: number; name: string; variant: string | null }[];
}

export type Ticket = TokenTicket | KitchenTicket;

/**
 * The same convention as the PDF receipt (bill.pdf.ts:87, receipt.pdf.ts:94):
 * en-IN, Asia/Kolkata, hardcoded. There is no timezone on `businesses`, and
 * a second convention here would print a different time on the paper than
 * the one on the screen beside it.
 */
export function formatTicketTime(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
  });
  const time = d.toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${day}, ${time}`;
}

/** Time alone. The pass cares what time this fired, never what date. */
export function formatTicketClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function encodeTicket(t: Ticket, width: PaperWidth): Uint8Array {
  const cols = columnsFor(width);
  switch (t.kind) {
    case "token":
      return tokenSlip(t, cols);
    case "kitchen":
      return kitchenTicket(t, cols);
  }
}

function tokenSlip(t: TokenTicket, cols: number): Uint8Array {
  const p = new EscPos().init();

  p.line(centre(t.businessName, cols));
  p.line();
  p.line(centre("TOKEN", cols));

  // Double width halves the usable columns, so the number is centred
  // against half the roll or it lands off to the right.
  p.double(true).line(centre(String(t.token), Math.floor(cols / 2))).double(false);

  if (t.seq > 1) p.line(centre(`Round ${t.seq}`, cols));

  p.line();
  p.line(centre(`Table ${t.tableLabel}`, cols));
  p.line(centre(formatTicketTime(t.at), cols));
  p.line();
  p.line(rule(cols));
  p.line(centre("Please keep this slip", cols));

  return p.cut().bytes();
}

function kitchenTicket(t: KitchenTicket, cols: number): Uint8Array {
  const p = new EscPos().init();

  p.line(rule(cols));
  p.line(twoCol(`TOKEN ${t.token}`, `TABLE ${t.tableLabel}`, cols));
  if (t.seq > 1) p.line(centre(`*** ROUND ${t.seq} — NEW ITEMS ***`, cols));
  if (t.isRunning) p.line(centre("** RUNNING TABLE **", cols));
  p.line(twoCol(formatTicketClock(t.at), `KOT #${t.kotNumber}`, cols));
  p.line(rule(cols));
  p.line();

  // Double height only: double width would halve the columns and wrap every
  // dish name. This is read at arm's length, not across a room.
  p.doubleHeight(true);
  for (const i of t.items) {
    for (const l of wrap(`${i.quantity} x ${i.name}`, cols, 4)) p.line(l);
    if (i.variant) p.line(`    (${i.variant})`);
  }
  p.doubleHeight(false);

  if (t.note) for (const l of wrap(`>> ${t.note}`, cols, 3)) p.line(l);

  p.line();
  p.line(rule(cols, "-"));
  p.line(twoCol("Items", String(t.items.reduce((s, i) => s + i.quantity, 0)), cols));

  return p.cut().bytes();
}
