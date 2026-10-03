import type { DateRange, PaymentMode } from "@menu/shared";

/*
 * Response shapes of the sales API (apps/api/src/sales). Money is a string
 * throughout — the API never puts it through a JS float, and neither should
 * anything that only displays or re-exports it.
 */

export interface BillRow {
  id: string;
  orderId: string;
  billNumber: number;
  tableLabel: string;
  issuedAt: string;
  total: string;
  items: number;
  paymentMode: PaymentMode | null;
  paidAt: string | null;
}

export interface Totals {
  count: number;
  gross: string;
  tax: string;
  serviceCharge: string;
  roundOff: string;
  net: string;
  byMode: Record<PaymentMode | "unpaid", string>;
}

export interface ExportLine {
  name: string;
  variant: string | null;
  category: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  lineNet: string;
  taxRate: string;
  taxAmount: string;
}

export interface ExportBill {
  id: string;
  billNumber: number;
  issuedAt: string;
  tableLabel: string;
  paymentMode: PaymentMode | null;
  paidAt: string | null;
  subtotal: string;
  taxTotal: string;
  serviceCharge: string;
  roundOff: string;
  total: string;
  pricesIncludeTax: boolean;
  taxLabel: string;
  gstin: string | null;
  lines: ExportLine[];
}

export interface ExportBusiness {
  name: string;
  timezone: string;
  currency: string;
}

export type Kpis = Totals & { avgBill: string; itemsSold: number };

export interface Analytics {
  range: DateRange;
  previous: DateRange;
  timezone: string;
  currency: string;
  kpis: { current: Kpis; previous: Kpis };
  series: { bucket: "day" | "week" | "month"; points: { start: string; gross: string; bills: number }[] };
  items: { name: string; variant: string | null; category: string; qty: number; gross: string }[];
  categories: { category: string; qty: number; gross: string }[];
  /** dow 1 = Monday … 7 = Sunday, local time. */
  heatmap: { dow: number; hour: number; bills: number; gross: string }[];
  tables: { label: string; bills: number; gross: string }[];
  kitchen: { toAccept: number | null; toReady: number | null; toServe: number | null; toPay: number | null; orders: number };
  cancellations: { units: number; value: string; byReason: { reason: string; units: number }[] };
  /** Index 0 = one star. */
  ratings: { average: number | null; count: number; distribution: number[] };
}

export interface SalesPage {
  bills: BillRow[];
  nextCursor: string | null;
  totals: Totals | null;
}

export interface ExportPage {
  business: ExportBusiness;
  bills: ExportBill[];
  nextCursor: string | null;
}
