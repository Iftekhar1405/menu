import type { BillTicket, KitchenTicket, TokenTicket } from "@menu/shared";
import type { Bill } from "../billing/billing.service";

/**
 * Everything a round's two tickets need, in the shape the queries return.
 *
 * Deliberately not a Prisma type: this file is pure so it can be tested
 * without a database, and a Prisma payload type would drag the client in
 * and make the fixtures above twenty lines longer each.
 */
export interface TicketSource {
  businessName: string;
  order: {
    dailyNumber: number;
    note: string | null;
    isRunning: boolean;
    tableLabel: string;
  };
  round: {
    seq: number;
    kotNumber: number;
    placedAt: Date;
    items: { quantity: number; nameSnapshot: string; variantSnapshot: string | null }[];
  };
}

export function tokenTicketFrom(src: TicketSource): TokenTicket {
  return {
    kind: "token",
    businessName: src.businessName,
    // The ORDER's number, not the round's. One table, one number, whatever
    // round they are on — otherwise the counter cannot match a slip to food.
    token: src.order.dailyNumber,
    seq: src.round.seq,
    tableLabel: src.order.tableLabel,
    at: src.round.placedAt.toISOString(),
  };
}

export function kitchenTicketFrom(src: TicketSource): KitchenTicket {
  return {
    kind: "kitchen",
    token: src.order.dailyNumber,
    tableLabel: src.order.tableLabel,
    kotNumber: src.round.kotNumber,
    seq: src.round.seq,
    isRunning: src.order.isRunning,
    // order_items has no note column; what a diner can write is the order's.
    note: src.order.note,
    at: src.round.placedAt.toISOString(),
    items: src.round.items.map((i) => ({
      quantity: i.quantity,
      name: i.nameSnapshot,
      variant: i.variantSnapshot,
    })),
  };
}

/**
 * The Bill the screen and the PDF both show, as paper.
 *
 * Nothing is recomputed here — every number is carried across as the string
 * `generate_bill` produced. A receipt whose paper total disagrees with its
 * screen total is the worst bug this feature could have, and the only way
 * to be sure is to do no arithmetic.
 */
export function billTicketFrom(bill: Bill, token: number): BillTicket {
  const b = bill.business;

  // Two of these five fields are filled in at a typical venue. Blank lines
  // on a receipt look like a broken printer.
  const cityStatePostal = [b.city, b.state].filter(Boolean).join(", ") + (b.postalCode ? ` ${b.postalCode}` : "");
  const addressLines = [b.addressLine1, b.addressLine2, cityStatePostal]
    .map((l) => (l ?? "").trim())
    .filter((l) => l.length > 0);

  return {
    kind: "bill",
    businessName: b.name,
    addressLines,
    gstin: b.gstin,
    billNumber: bill.billNumber,
    tableLabel: bill.tableLabel,
    token,
    issuedAt: bill.issuedAt,
    taxLine: taxLineFor(bill),
    subtotal: bill.subtotal,
    taxTotal: bill.taxTotal,
    serviceCharge: bill.serviceCharge,
    serviceChargeRate: bill.serviceChargeRate,
    roundOff: bill.roundOff,
    total: bill.total,
    receiptFooter: bill.receiptFooter,
    lines: bill.lines.map((l) => ({
      name: l.name,
      variant: l.variant,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
    })),
  };
}

/**
 * "GST 5% (incl.)", or just "GST", or nothing.
 *
 * The rate is named only when every line carries the same one. Rates are
 * snapshotted per round on purpose, so a price or rate change mid-meal
 * leaves lines that disagree — and naming one of them on the paper would
 * state a rate the customer was not charged.
 */
function taxLineFor(bill: Bill): string | null {
  if (Number(bill.taxTotal) === 0) return null;

  const rates = new Set(bill.lines.map((l) => Number(l.taxRate)));
  if (rates.size !== 1) return bill.taxLabel;

  const rate = [...rates][0]!;
  const suffix = bill.pricesIncludeTax ? "incl." : "excl.";
  // Number("5.00") is 5, so this drops the trailing zeros for free:
  // "GST 5%" reads better than "GST 5.00%", and 12.5% still prints as 12.5%.
  return `${bill.taxLabel} ${rate}% (${suffix})`;
}
