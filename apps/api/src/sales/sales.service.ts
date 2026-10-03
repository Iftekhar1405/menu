import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { timezoneFor, type PaymentMode, type SalesFilter } from "@menu/shared";
import { BusinessesService } from "../businesses/businesses.service";
import { PrismaService } from "../prisma/prisma.service";
import { buildBillPdf } from "../billing/bill.pdf";
import { shapeBill } from "../billing/billing.service";
import { MediaService } from "../media/media.service";
import { assertAllFound, billPdfName, zipPdfs } from "./pdf-batch";
import { CURSOR_AT, LINE_CATEGORY_JOIN, afterCursor, beforeCursor, billWhere, decodeCursor, encodeCursor } from "./sales-filter.sql";

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

const PAGE = 50;

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

const EXPORT_PAGE = 1000;

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businesses: BusinessesService,
    private readonly media: MediaService,
  ) {}

  async context(userId: string, businessId: string) {
    const business = await this.businesses.assertOwns(userId, businessId);
    return { business, tz: timezoneFor(business.country) };
  }

  async list(userId: string, businessId: string, filter: SalesFilter, cursor?: string) {
    const { tz } = await this.context(userId, businessId);
    const where = billWhere(filter, businessId, tz);
    const after = cursor ? decodeCursor(cursor) : null;
    if (cursor && !after) throw new BadRequestException("That page link has expired");

    const rows = await this.prisma.db.$queryRaw<
      {
        id: string; order_id: string; bill_number: number; table_label: string; issued_at: Date;
        total: string; items: number; payment_mode: PaymentMode | null; paid_at: Date | null; cursor_at: string;
      }[]
    >`
      SELECT b.id, b.order_id, b.bill_number, b.table_label, b.issued_at, b.total::text AS total,
             b.payment_mode::text AS payment_mode, b.paid_at, ${CURSOR_AT} AS cursor_at,
             COALESCE((SELECT SUM(l.quantity) FROM bill_lines l WHERE l.bill_id = b.id), 0)::int AS items
      FROM bills b
      WHERE ${where} AND ${beforeCursor(after)}
      ORDER BY b.issued_at DESC, b.id DESC
      LIMIT ${PAGE + 1}`;

    const page = rows.slice(0, PAGE);
    const last = page[page.length - 1];
    return {
      bills: page.map<BillRow>((r) => ({
        id: r.id,
        orderId: r.order_id,
        billNumber: r.bill_number,
        tableLabel: r.table_label,
        issuedAt: r.issued_at.toISOString(),
        total: r.total,
        items: r.items,
        paymentMode: r.payment_mode,
        paidAt: r.paid_at ? r.paid_at.toISOString() : null,
      })),
      nextCursor: rows.length > PAGE && last ? encodeCursor({ issuedAt: last.cursor_at, id: last.id }) : null,
      // Totals for the whole filter, only on the first page — later pages
      // would recompute the same numbers.
      totals: after ? null : await this.totals(where),
    };
  }

  async totals(where: Prisma.Sql): Promise<Totals> {
    const [t] = await this.prisma.db.$queryRaw<
      { count: number; gross: string; tax: string; service: string; round_off: string; net: string;
        cash: string; upi: string; card: string; other: string; unpaid: string }[]
    >`
      SELECT count(*)::int AS count,
             COALESCE(sum(b.total), 0)::text AS gross,
             COALESCE(sum(b.tax_total), 0)::text AS tax,
             COALESCE(sum(b.service_charge), 0)::text AS service,
             COALESCE(sum(b.round_off), 0)::text AS round_off,
             COALESCE(sum(b.total - b.tax_total), 0)::text AS net,
             COALESCE(sum(b.total) FILTER (WHERE b.payment_mode = 'cash'), 0)::text AS cash,
             COALESCE(sum(b.total) FILTER (WHERE b.payment_mode = 'upi'), 0)::text AS upi,
             COALESCE(sum(b.total) FILTER (WHERE b.payment_mode = 'card'), 0)::text AS card,
             COALESCE(sum(b.total) FILTER (WHERE b.payment_mode = 'other'), 0)::text AS other,
             COALESCE(sum(b.total) FILTER (WHERE b.payment_mode IS NULL), 0)::text AS unpaid
      FROM bills b WHERE ${where}`;
    return {
      count: t!.count,
      gross: t!.gross,
      tax: t!.tax,
      serviceCharge: t!.service,
      roundOff: t!.round_off,
      net: t!.net,
      byMode: { cash: t!.cash, upi: t!.upi, card: t!.card, other: t!.other, unpaid: t!.unpaid },
    };
  }

  /**
   * Corrects how a paid bill was settled. Amounts are untouched. The change is
   * logged on the order's timeline, so a correction is visible, not silent.
   */
  async changePaymentMode(userId: string, businessId: string, billId: string, mode: PaymentMode) {
    await this.businesses.assertOwns(userId, businessId);
    const bill = await this.prisma.db.bill.findFirst({
      where: { id: billId, businessId },
      select: { id: true, orderId: true, paymentMode: true, paidAt: true },
    });
    if (!bill) throw new NotFoundException("Bill not found");
    if (!bill.paidAt || !bill.paymentMode) {
      throw new ConflictException("Mark the order paid first");
    }
    if (bill.paymentMode === mode) return { id: bill.id, paymentMode: mode, paidAt: bill.paidAt.toISOString() };

    await this.prisma.db.bill.update({ where: { id: bill.id }, data: { paymentMode: mode } });
    await this.prisma.db.orderEvent.create({
      data: {
        orderId: bill.orderId,
        businessId,
        kind: "payment_mode_changed",
        data: { from: bill.paymentMode, to: mode },
      },
    });
    return { id: bill.id, paymentMode: mode, paidAt: bill.paidAt.toISOString() };
  }

  async exportRows(userId: string, businessId: string, filter: SalesFilter, cursor?: string) {
    const { tz, business } = await this.context(userId, businessId);
    const after = cursor ? decodeCursor(cursor) : null;
    if (cursor && !after) throw new BadRequestException("That page link has expired");
    const where = billWhere(filter, businessId, tz);

    // Oldest first: a register reads forwards in time.
    const bills = await this.prisma.db.$queryRaw<
      {
        id: string; bill_number: number; issued_at: Date; table_label: string;
        payment_mode: PaymentMode | null; paid_at: Date | null; subtotal: string; tax_total: string;
        service_charge: string; round_off: string; total: string; prices_include_tax: boolean;
        tax_label: string; gstin: string | null; cursor_at: string;
      }[]
    >`
      SELECT b.id, b.bill_number, b.issued_at, b.table_label, b.payment_mode::text AS payment_mode, b.paid_at,
             b.subtotal::text AS subtotal, b.tax_total::text AS tax_total, b.service_charge::text AS service_charge,
             b.round_off::text AS round_off, b.total::text AS total, b.prices_include_tax, b.tax_label,
             b.business_snapshot->>'gstin' AS gstin, ${CURSOR_AT} AS cursor_at
      FROM bills b
      WHERE ${where} AND ${afterCursor(after)}
      ORDER BY b.issued_at ASC, b.id ASC
      LIMIT ${EXPORT_PAGE + 1}`;

    const page = bills.slice(0, EXPORT_PAGE);
    const ids = page.map((b) => b.id);
    const lines = ids.length
      ? await this.prisma.db.$queryRaw<
          { bill_id: string; name: string; variant: string | null; category: string | null; deleted: boolean;
            quantity: number; unit_price: string; line_total: string; line_net: string; tax_rate: string; tax_amount: string }[]
        >`
          SELECT l.bill_id, l.name, l.variant, cat.category_name AS category, (cat.menu_item_id IS NULL) AS deleted,
                 l.quantity, l.unit_price::text AS unit_price, l.line_total::text AS line_total,
                 l.line_net::text AS line_net, l.tax_rate::text AS tax_rate, l.tax_amount::text AS tax_amount
          FROM bill_lines l
          JOIN bills b ON b.id = l.bill_id
          ${LINE_CATEGORY_JOIN}
          WHERE l.bill_id = ANY(${ids}::uuid[])
          ORDER BY l.bill_id, l.position`
      : [];

    const byBill = new Map<string, ExportLine[]>();
    for (const l of lines) {
      const list = byBill.get(l.bill_id) ?? [];
      list.push({
        name: l.name,
        variant: l.variant,
        category: l.category ?? (l.deleted ? "Deleted item" : "Uncategorised"),
        quantity: l.quantity,
        unitPrice: l.unit_price,
        lineTotal: l.line_total,
        lineNet: l.line_net,
        taxRate: l.tax_rate,
        taxAmount: l.tax_amount,
      });
      byBill.set(l.bill_id, list);
    }

    const last = page[page.length - 1];
    return {
      business: { name: business.name, timezone: tz, currency: business.currency } satisfies ExportBusiness,
      bills: page.map<ExportBill>((b) => ({
        id: b.id,
        billNumber: b.bill_number,
        issuedAt: b.issued_at.toISOString(),
        tableLabel: b.table_label,
        paymentMode: b.payment_mode,
        paidAt: b.paid_at ? b.paid_at.toISOString() : null,
        subtotal: b.subtotal,
        taxTotal: b.tax_total,
        serviceCharge: b.service_charge,
        roundOff: b.round_off,
        total: b.total,
        pricesIncludeTax: b.prices_include_tax,
        taxLabel: b.tax_label,
        gstin: b.gstin,
        lines: byBill.get(b.id) ?? [],
      })),
      nextCursor: bills.length > EXPORT_PAGE && last ? encodeCursor({ issuedAt: last.cursor_at, id: last.id }) : null,
    };
  }

  async pdfBatch(userId: string, businessId: string, billIds: string[]): Promise<Uint8Array> {
    await this.businesses.assertOwns(userId, businessId);
    const bills = await this.prisma.db.bill.findMany({
      where: { id: { in: billIds }, businessId },
      include: { lines: { orderBy: { position: "asc" } } },
      orderBy: { billNumber: "asc" },
    });
    assertAllFound(billIds, bills);

    // A logo changes rarely; fetch each distinct one once per batch.
    const logos = new Map<string | null, Promise<Buffer | null>>();
    const files: { name: string; bytes: Uint8Array }[] = [];
    for (const raw of bills) {
      const bill = shapeBill(raw);
      const path = bill.business.logoPath ?? null;
      if (!logos.has(path)) logos.set(path, this.media.imageBytes(path));
      const pdf = await buildBillPdf(bill, await logos.get(path)!);
      files.push({ name: billPdfName(bill.billNumber), bytes: new Uint8Array(pdf) });
    }
    return zipPdfs(files);
  }
}
