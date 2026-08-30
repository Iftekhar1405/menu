import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { MerchStatus } from "@prisma/client";
import { BusinessesService } from "../businesses/businesses.service";
import { PrismaService } from "../prisma/prisma.service";

export interface MerchLineInput {
  productId: string;
  quantity: number;
  /** Which tables' codes to print. Empty for a product that is not per-table. */
  tableIds: string[];
}

export interface MerchRequestInput {
  contactName: string;
  contactPhone: string;
  contactEmail?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  notes?: string | null;
  items: MerchLineInput[];
}

const ALLOWED_TRANSITIONS: Record<MerchStatus, MerchStatus[]> = {
  requested: ["quoted", "cancelled"],
  quoted: ["confirmed", "cancelled"],
  confirmed: ["in_production", "cancelled"],
  in_production: ["shipped", "cancelled"],
  shipped: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

/**
 * Fields an owner must never receive. RLS is row-level, so an owner who can
 * legitimately read their own order row could also read our internal notes and
 * quoted price if the API handed the whole row back. Withholding happens here.
 */
const OWNER_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  contactName: true,
  contactPhone: true,
  contactEmail: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  state: true,
  postalCode: true,
  country: true,
  notes: true,
  estimatedTotal: true,
  quotedTotal: true,
  createdAt: true,
  updatedAt: true,
  items: {
    select: {
      id: true,
      quantity: true,
      unitPrice: true,
      tableIds: true,
      product: { select: { id: true, sku: true, name: true, perTable: true } },
    },
  },
} as const;

@Injectable()
export class MerchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businesses: BusinessesService,
  ) {}

  // ── Catalogue ─────────────────────────────────────────────────────────────

  async catalogue() {
    return this.prisma.db.merchProduct.findMany({
      where: { isActive: true },
      orderBy: { position: "asc" },
    });
  }

  // ── Owner ─────────────────────────────────────────────────────────────────

  /**
   * Submits a request. Not a purchase — there is no payment in this system, so
   * this records what the owner wants and where to send it, and we quote and
   * fulfil offline.
   *
   * Prices come from the catalogue, server-side, and are snapshotted onto the
   * line. The estimate is arithmetic the owner can see before we quote; it is
   * explicitly not a price we are bound to.
   */
  async request(userId: string, businessId: string, input: MerchRequestInput) {
    await this.businesses.assertOwns(userId, businessId);

    if (input.items.length === 0) {
      throw new BadRequestException("Choose at least one product");
    }

    const products = await this.prisma.db.merchProduct.findMany({
      where: { id: { in: input.items.map((i) => i.productId) }, isActive: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    // Tables are validated against this business, so a request cannot name
    // another restaurant's table and pull its artwork into our print queue.
    const requestedTableIds = [...new Set(input.items.flatMap((i) => i.tableIds))];
    if (requestedTableIds.length > 0) {
      const owned = await this.prisma.db.table.count({
        where: { id: { in: requestedTableIds }, businessId },
      });
      if (owned !== requestedTableIds.length) {
        throw new BadRequestException("One of those tables is not yours");
      }
    }

    let estimate = 0;
    const lines = input.items.map((line) => {
      const product = byId.get(line.productId);
      if (!product) throw new BadRequestException("That product is not available");

      // For a per-table product the quantity is the number of tables chosen:
      // one card per table is the whole point, and letting the two disagree
      // produces an unfulfillable order.
      const quantity = product.perTable ? line.tableIds.length : line.quantity;

      if (quantity < product.minQuantity) {
        throw new BadRequestException(
          product.perTable
            ? `Choose at least ${product.minQuantity} tables for ${product.name}`
            : `Minimum order for ${product.name} is ${product.minQuantity}`,
        );
      }

      estimate += Number(product.unitPrice) * quantity;

      return {
        productId: product.id,
        quantity,
        unitPrice: product.unitPrice,
        tableIds: product.perTable ? line.tableIds : [],
      };
    });

    const [{ next_merch_order_number: orderNumber }] = await this.prisma.db.$queryRaw<
      { next_merch_order_number: number }[]
    >`SELECT next_merch_order_number()`;

    return this.prisma.db.merchOrder.create({
      data: {
        businessId,
        orderNumber,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        contactEmail: input.contactEmail ?? null,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2 ?? null,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        country: input.country ?? "IN",
        notes: input.notes ?? null,
        estimatedTotal: estimate,
        items: { create: lines },
      },
      select: OWNER_SELECT,
    });
  }

  async listForBusiness(userId: string, businessId: string) {
    await this.businesses.assertOwns(userId, businessId);
    return this.prisma.db.merchOrder.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" },
      select: OWNER_SELECT,
    });
  }

  // ── Platform admin ────────────────────────────────────────────────────────
  //
  // These read across every business, which is the one place in the system
  // that happens. The guard is the role check on the controller plus the
  // second clause on the merch RLS policies — nothing else widens.

  async listAll(status?: MerchStatus) {
    return this.prisma.db.merchOrder.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        business: { select: { id: true, name: true, publicCode: true } },
        items: { include: { product: true } },
      },
    });
  }

  async adminGet(orderId: string) {
    const order = await this.prisma.db.merchOrder.findUnique({
      where: { id: orderId },
      include: {
        business: { select: { id: true, name: true, publicCode: true } },
        items: { include: { product: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }

  async adminUpdate(
    orderId: string,
    patch: { status?: MerchStatus; adminNotes?: string | null; quotedTotal?: number | null },
  ) {
    const order = await this.prisma.db.merchOrder.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundException("Order not found");

    if (patch.status && patch.status !== order.status) {
      if (!ALLOWED_TRANSITIONS[order.status].includes(patch.status)) {
        throw new ForbiddenException(
          `An order that is ${order.status} cannot move to ${patch.status}`,
        );
      }
    }

    return this.prisma.db.merchOrder.update({
      where: { id: orderId },
      data: {
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.adminNotes !== undefined && { adminNotes: patch.adminNotes }),
        ...(patch.quotedTotal !== undefined && { quotedTotal: patch.quotedTotal }),
      },
      include: {
        business: { select: { id: true, name: true, publicCode: true } },
        items: { include: { product: true } },
      },
    });
  }

  /** Every table named across an order, for generating the print artwork. */
  async tablesForOrder(orderId: string) {
    const order = await this.adminGet(orderId);
    const tableIds = [...new Set(order.items.flatMap((i) => i.tableIds))];

    const tables = await this.prisma.db.table.findMany({
      where: { id: { in: tableIds } },
      orderBy: { position: "asc" },
    });

    return { order, tables };
  }
}
