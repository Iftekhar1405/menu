import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { BusinessesService } from "../businesses/businesses.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContext } from "../prisma/tenant-context";
import { cleanPgMessage } from "../common/pg-message";

export interface BillLine {
  id: string;
  name: string;
  variant: string | null;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  taxRate: string;
  taxAmount: string;
}

export interface Bill {
  id: string;
  billNumber: number;
  tableLabel: string;
  issuedAt: string;
  currency: string;
  taxLabel: string;
  pricesIncludeTax: boolean;
  business: {
    name: string;
    gstin: string | null;
    logoPath: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  };
  receiptFooter: string | null;
  subtotal: string;
  taxTotal: string;
  serviceCharge: string;
  serviceChargeRate: string;
  roundOff: string;
  total: string;
  lines: BillLine[];
}

export interface TaxConfig {
  taxEnabled: boolean;
  taxLabel: string;
  defaultTaxRate: number;
  pricesIncludeTax: boolean;
  gstin: string | null;
  serviceChargeEnabled: boolean;
  serviceChargeRate: number;
  receiptFooter: string | null;
}

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businesses: BusinessesService,
    private readonly tenant: TenantContext,
  ) {}

  // ── Staff ─────────────────────────────────────────────────────────────────

  /**
   * Generates the bill for an order, or returns the one that already exists.
   *
   * The arithmetic lives in `generate_bill` rather than here. A bill is a set
   * of numbers that must agree with one another, and computing lines in one
   * round trip and totals in another is how you end up with a receipt whose
   * lines do not add up to its total.
   */
  async generate(userId: string, businessId: string, orderId: string): Promise<Bill> {
    await this.businesses.assertOwns(userId, businessId);

    const order = await this.prisma.db.order.findFirst({
      where: { id: orderId, businessId },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.status === "cancelled") {
      throw new BadRequestException("A cancelled order has no bill");
    }

    await this.prisma.db.$queryRaw`SELECT generate_bill(${orderId}::uuid, ${businessId}::uuid)`;
    return this.forOrder(userId, businessId, orderId);
  }

  async forOrder(userId: string, businessId: string, orderId: string): Promise<Bill> {
    await this.businesses.assertOwns(userId, businessId);

    const bill = await this.prisma.db.bill.findFirst({
      where: { orderId, businessId },
      include: { lines: { orderBy: { position: "asc" } } },
    });
    if (!bill) throw new NotFoundException("No bill has been generated for that order");

    return shapeBill(bill);
  }

  /** Owner access has no window. This is their own sales record. */
  async listBills(userId: string, businessId: string, limit = 50) {
    await this.businesses.assertOwns(userId, businessId);
    const bills = await this.prisma.db.bill.findMany({
      where: { businessId },
      orderBy: { issuedAt: "desc" },
      take: Math.min(limit, 200),
      include: { lines: { orderBy: { position: "asc" } } },
    });
    return bills.map(shapeBill);
  }

  async getTaxConfig(userId: string, businessId: string): Promise<TaxConfig> {
    const business = await this.businesses.assertOwns(userId, businessId);
    return {
      taxEnabled: business.taxEnabled,
      taxLabel: business.taxLabel,
      defaultTaxRate: Number(business.defaultTaxRate),
      pricesIncludeTax: business.pricesIncludeTax,
      gstin: business.gstin,
      serviceChargeEnabled: business.serviceChargeEnabled,
      serviceChargeRate: Number(business.serviceChargeRate),
      receiptFooter: business.receiptFooter,
    };
  }

  async setTaxConfig(
    userId: string,
    businessId: string,
    patch: Partial<TaxConfig>,
  ): Promise<TaxConfig> {
    await this.businesses.assertOwns(userId, businessId);
    await this.prisma.db.business.update({
      where: { id: businessId },
      data: {
        ...(patch.taxEnabled !== undefined && { taxEnabled: patch.taxEnabled }),
        ...(patch.taxLabel !== undefined && { taxLabel: patch.taxLabel }),
        ...(patch.defaultTaxRate !== undefined && { defaultTaxRate: patch.defaultTaxRate }),
        ...(patch.pricesIncludeTax !== undefined && {
          pricesIncludeTax: patch.pricesIncludeTax,
        }),
        ...(patch.gstin !== undefined && { gstin: patch.gstin }),
        ...(patch.serviceChargeEnabled !== undefined && {
          serviceChargeEnabled: patch.serviceChargeEnabled,
        }),
        ...(patch.serviceChargeRate !== undefined && {
          serviceChargeRate: patch.serviceChargeRate,
        }),
        ...(patch.receiptFooter !== undefined && { receiptFooter: patch.receiptFooter }),
      },
    });
    return this.getTaxConfig(userId, businessId);
  }

  /** First-party ratings, ours whether or not anyone reached Google. */
  async listRatings(userId: string, businessId: string, days = 30) {
    await this.businesses.assertOwns(userId, businessId);
    const since = new Date(Date.now() - days * 86_400_000);

    const [ratings, aggregate] = await Promise.all([
      this.prisma.db.orderRating.findMany({
        where: { businessId, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      this.prisma.db.orderRating.aggregate({
        where: { businessId, createdAt: { gte: since } },
        _avg: { stars: true },
        _count: true,
      }),
    ]);

    return {
      average: aggregate._avg.stars ? Number(aggregate._avg.stars.toFixed(2)) : null,
      count: aggregate._count,
      ratings,
    };
  }

  // ── Diner ─────────────────────────────────────────────────────────────────
  //
  // Every one of these goes through a SECURITY DEFINER function that takes a
  // table id and no bill id. The 30- and 10-minute windows are predicates
  // inside those functions rather than checks here: a window enforced in
  // application code is a window somebody eventually forgets to enforce.

  async billForTable(tableId: string): Promise<Bill | null> {
    return this.tenant.withoutTenant(async (db) => {
      const rows = await db.$queryRaw<
        { get_table_bill: Bill | null }[]
      >`SELECT get_table_bill(${tableId}::uuid) AS get_table_bill`;
      return rows[0]?.get_table_bill ?? null;
    });
  }

  async removeServiceCharge(tableId: string): Promise<Bill | null> {
    return this.tenant.withoutTenant(async (db) => {
      const rows = await db.$queryRaw<
        { remove_service_charge: Bill | null }[]
      >`SELECT remove_service_charge(${tableId}::uuid) AS remove_service_charge`;
      return rows[0]?.remove_service_charge ?? null;
    });
  }

  async ratableOrder(tableId: string) {
    return this.tenant.withoutTenant(async (db) => {
      const rows = await db.$queryRaw<
        { get_ratable_order: RatableOrder | null }[]
      >`SELECT get_ratable_order(${tableId}::uuid) AS get_ratable_order`;
      return rows[0]?.get_ratable_order ?? null;
    });
  }

  async reviewPrompts(businessId: string, band: "low" | "good" | "great") {
    return this.tenant.withoutTenant(async (db) => {
      const rows = await db.$queryRaw<
        { get_review_prompts: { id: string; text: string }[] }[]
      >`SELECT get_review_prompts(${businessId}::uuid, ${band}) AS get_review_prompts`;
      return rows[0]?.get_review_prompts ?? [];
    });
  }

  async submitRating(
    tableId: string,
    stars: number,
    promptId: string | null,
    feedback: string | null,
  ): Promise<{ ok: boolean; googlePlaceId: string | null }> {
    return this.tenant.withoutTenant(async (db) => {
      try {
        const rows = await db.$queryRaw<
          { submit_order_rating: { ok: boolean; googlePlaceId: string | null } }[]
        >`SELECT submit_order_rating(${tableId}::uuid, ${stars}::int, ${promptId}::uuid, ${feedback}) AS submit_order_rating`;
        return rows[0]!.submit_order_rating;
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        const match = /ERROR: (.+)/.exec(message);
        if (match) throw new BadRequestException(cleanPgMessage(match[1]!));
        throw err;
      }
    });
  }
}

export interface RatableOrder {
  orderId: string;
  businessId: string;
  googlePlaceId: string | null;
  businessName: string;
  businessType: string;
}

/** Prisma Decimals become strings so money never touches a JS float. */
function shapeBill(bill: {
  id: string;
  billNumber: number;
  tableLabel: string;
  issuedAt: Date;
  currency: string;
  taxLabel: string;
  pricesIncludeTax: boolean;
  businessSnapshot: unknown;
  receiptFooter: string | null;
  subtotal: unknown;
  taxTotal: unknown;
  serviceCharge: unknown;
  serviceChargeRate: unknown;
  roundOff: unknown;
  total: unknown;
  lines: {
    id: string;
    name: string;
    variant: string | null;
    quantity: number;
    unitPrice: unknown;
    lineTotal: unknown;
    taxRate: unknown;
    taxAmount: unknown;
  }[];
}): Bill {
  return {
    id: bill.id,
    billNumber: bill.billNumber,
    tableLabel: bill.tableLabel,
    issuedAt: bill.issuedAt.toISOString(),
    currency: bill.currency,
    taxLabel: bill.taxLabel,
    pricesIncludeTax: bill.pricesIncludeTax,
    business: bill.businessSnapshot as Bill["business"],
    receiptFooter: bill.receiptFooter,
    subtotal: String(bill.subtotal),
    taxTotal: String(bill.taxTotal),
    serviceCharge: String(bill.serviceCharge),
    serviceChargeRate: String(bill.serviceChargeRate),
    roundOff: String(bill.roundOff),
    total: String(bill.total),
    lines: bill.lines.map((l) => ({
      id: l.id,
      name: l.name,
      variant: l.variant,
      quantity: l.quantity,
      unitPrice: String(l.unitPrice),
      lineTotal: String(l.lineTotal),
      taxRate: String(l.taxRate),
      taxAmount: String(l.taxAmount),
    })),
  };
}
