import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { timezoneFor, type PaymentMode, type SalesFilter } from "@menu/shared";
import { BusinessesService } from "../businesses/businesses.service";
import { PrismaService } from "../prisma/prisma.service";
import { afterCursor, billWhere, decodeCursor, encodeCursor } from "./sales-filter.sql";

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

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businesses: BusinessesService,
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
        total: string; items: number; payment_mode: PaymentMode | null; paid_at: Date | null;
      }[]
    >`
      SELECT b.id, b.order_id, b.bill_number, b.table_label, b.issued_at, b.total::text AS total,
             b.payment_mode::text AS payment_mode, b.paid_at,
             COALESCE((SELECT SUM(l.quantity) FROM bill_lines l WHERE l.bill_id = b.id), 0)::int AS items
      FROM bills b
      WHERE ${where} AND ${afterCursor(after)}
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
      nextCursor: rows.length > PAGE && last ? encodeCursor({ issuedAt: last.issued_at, id: last.id }) : null,
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
}
