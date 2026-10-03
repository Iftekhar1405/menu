import { PAYMENT_MODE_LABEL } from "@menu/shared";
import type { ExportBill } from "./types";

type Cell = string | number | boolean | null | undefined;

/**
 * RFC 4180, with a BOM so Excel reads UTF-8 (₹, é) correctly. A cell that
 * starts like a formula is prefixed with an apostrophe: a dish called
 * "=HYPERLINK(...)" must not become a live formula in the accountant's sheet.
 */
export function toCsv(rows: Cell[][]): string {
  const cell = (v: Cell): string => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function localParts(iso: string, tz: string): { date: string; time: string } {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return { date, time };
}

/** Sum money strings in paise to avoid float drift, back to 2 decimals. */
function sum(values: string[]): string {
  const paise = values.reduce((a, v) => a + Math.round(Number(v) * 100), 0);
  return (paise / 100).toFixed(2);
}

export function registerCsv(bills: ExportBill[], tz: string): string {
  return toCsv([
    ["Bill No", "Date", "Time", "Table", "Status", "Payment Mode", "Paid At", "Items", "Subtotal", "Tax",
      "Service Charge", "Round Off", "Total", "Prices Include Tax", "Tax Label", "GSTIN"],
    ...bills.map((b) => {
      const { date, time } = localParts(b.issuedAt, tz);
      const paid = b.paidAt ? localParts(b.paidAt, tz) : null;
      return [
        b.billNumber, date, time, b.tableLabel, b.paymentMode ? "Paid" : "Unpaid",
        b.paymentMode ? PAYMENT_MODE_LABEL[b.paymentMode] : "", paid ? `${paid.date} ${paid.time}` : "",
        b.lines.reduce((a, l) => a + l.quantity, 0),
        b.subtotal, b.taxTotal, b.serviceCharge, b.roundOff, b.total,
        b.pricesIncludeTax ? "Yes" : "No", b.taxLabel, b.gstin ?? "",
      ];
    }),
  ]);
}

export function itemsCsv(bills: ExportBill[], tz: string): string {
  return toCsv([
    ["Bill No", "Date", "Item", "Variant", "Category", "Qty", "Unit Price", "Line Total", "Net", "Tax Rate %", "Tax Amount"],
    ...bills.flatMap((b) => {
      const { date } = localParts(b.issuedAt, tz);
      return b.lines.map((l) => [
        b.billNumber, date, l.name, l.variant ?? "", l.category, l.quantity, l.unitPrice, l.lineTotal, l.lineNet, l.taxRate, l.taxAmount,
      ]);
    }),
  ]);
}

export function dailyCsv(bills: ExportBill[], tz: string): string {
  const byDay = new Map<string, ExportBill[]>();
  for (const b of bills) {
    const { date } = localParts(b.issuedAt, tz);
    byDay.set(date, [...(byDay.get(date) ?? []), b]);
  }
  const row = (label: string, list: ExportBill[]) => {
    const mode = (m: string | null) => sum(list.filter((b) => b.paymentMode === m).map((b) => b.total));
    return [
      label, list.length, sum(list.map((b) => b.total)),
      sum(list.map((b) => (Number(b.total) - Number(b.taxTotal)).toFixed(2))),
      sum(list.map((b) => b.taxTotal)), sum(list.map((b) => b.serviceCharge)), sum(list.map((b) => b.roundOff)),
      mode("cash"), mode("upi"), mode("card"), mode("other"), mode(null),
    ];
  };
  return toCsv([
    ["Date", "Bills", "Gross", "Net", "Tax", "Service Charge", "Round Off", "Cash", "UPI", "Card", "Other", "Unpaid"],
    ...[...byDay.keys()].sort().map((d) => row(d, byDay.get(d)!)),
    row("Total", bills),
  ]);
}

export function readmeText(meta: { businessName: string; from: string; to: string; timezone: string; filtersText: string; generatedAt: string; bills: number; includesPdfs: boolean }): string {
  return [
    `Sales export — ${meta.businessName}`,
    `Period: ${meta.from} to ${meta.to} (${meta.timezone})`,
    `Filters: ${meta.filtersText}`,
    `Bills: ${meta.bills}`,
    `Generated: ${meta.generatedAt}`,
    "",
    "sales-register.csv  one row per bill",
    "bill-items.csv      one row per item on each bill",
    "daily-summary.csv   totals per day, with the payment split; last row is the period total",
    meta.includesPdfs ? "bills/              the A5 bill for each bill number" : "",
    "",
    "Gross = bill total. Net = total excluding tax. Unpaid = bills not marked paid.",
    "These are receipts showing tax, not GST tax invoices.",
    "",
  ].join("\r\n");
}
