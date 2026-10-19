import { EscPos } from "./bytes";
import { centre, columnsFor, rule, type PaperWidth } from "./layout";

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

export type Ticket = TokenTicket;

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

export function encodeTicket(t: Ticket, width: PaperWidth): Uint8Array {
  const cols = columnsFor(width);
  switch (t.kind) {
    case "token":
      return tokenSlip(t, cols);
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
