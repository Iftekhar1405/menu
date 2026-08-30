import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { BusinessesService } from "../businesses/businesses.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContext } from "../prisma/tenant-context";
import { cleanPgMessage } from "../common/pg-message";

export interface PlaceLine {
  itemId: string;
  variantId?: string | null;
  quantity: number;
}

/** What a diner is allowed to move an order to: nothing. Staff only. */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  placed: ["preparing", "ready", "completed", "cancelled"],
  preparing: ["ready", "completed", "cancelled"],
  ready: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

const OPEN_STATUSES: OrderStatus[] = ["placed", "preparing", "ready"];

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businesses: BusinessesService,
    private readonly tenant: TenantContext,
  ) {}

  // ── Diner side ────────────────────────────────────────────────────────────

  /**
   * Appends a round to the table's open order, creating the order if there
   * isn't one.
   *
   * The work happens inside `place_table_round`, a SECURITY DEFINER function,
   * for two reasons that are not about convenience. A diner has no
   * app.current_user_id, so the menu and order tables are correctly invisible
   * to them under RLS — the alternative would be widening those policies for
   * everyone. And doing it in one statement means prices are read from the
   * menu in the same transaction that writes them, and an advisory lock
   * serialises two phones tapping "Place order" at once into one order with
   * two batches rather than a lost race.
   *
   * The client sends item ids and quantities. It never sends a price.
   */
  async placeRound(
    businessId: string,
    tableId: string,
    lines: PlaceLine[],
  ): Promise<unknown> {
    if (lines.length === 0) throw new BadRequestException("Add something first");

    const payload = JSON.stringify(
      lines.map((l) => ({
        itemId: l.itemId,
        variantId: l.variantId ?? null,
        quantity: l.quantity,
      })),
    );

    return this.tenant.withoutTenant(async (db) => {
      try {
        const rows = await db.$queryRaw<
          { place_table_round: unknown }[]
        >`SELECT place_table_round(${tableId}::uuid, ${businessId}::uuid, ${payload}::jsonb) AS place_table_round`;
        return rows[0]?.place_table_round ?? null;
      } catch (err) {
        // The function raises check_violation for anything the diner can fix
        // themselves — a sold-out dish, a missing size. Those are 400s with
        // the message as written, not 500s.
        const message = err instanceof Error ? err.message : "";
        const match = /ERROR: (.+)/.exec(message);
        if (match) throw new BadRequestException(cleanPgMessage(match[1]!));
        throw err;
      }
    });
  }

  /** The table's open order, or null. Completed orders are gone from here. */
  async currentForTable(tableId: string): Promise<unknown | null> {
    return this.tenant.withoutTenant(async (db) => {
      const rows = await db.$queryRaw<
        { get_table_order: unknown | null }[]
      >`SELECT get_table_order(${tableId}::uuid) AS get_table_order`;
      return rows[0]?.get_table_order ?? null;
    });
  }

  /**
   * The diner's view of their own table.
   *
   * Goes through a SECURITY DEFINER function because `tables` is under the
   * owner RLS policy and a diner has no user id on the connection — an
   * ordinary query would correctly return nothing for them.
   */
  async tableContext(tableId: string, businessId: string): Promise<TableContext | null> {
    return this.tenant.withoutTenant(async (db) => {
      const rows = await db.$queryRaw<
        { get_table_context: TableContext | null }[]
      >`SELECT get_table_context(${tableId}::uuid, ${businessId}::uuid) AS get_table_context`;
      return rows[0]?.get_table_context ?? null;
    });
  }

  async resolveToken(token: string) {
    return this.tenant.withoutTenant(async (db) => {
      const rows = await db.$queryRaw<
        { resolve_table_token: ResolvedTable | null }[]
      >`SELECT resolve_table_token(${token}) AS resolve_table_token`;
      const resolved = rows[0]?.resolve_table_token;
      if (!resolved) throw new NotFoundException("That table code is not valid");
      return resolved;
    });
  }

  // ── Staff side ────────────────────────────────────────────────────────────

  async listForBusiness(userId: string, businessId: string, scope: "open" | "today") {
    await this.businesses.assertOwns(userId, businessId);

    // `business_day` is written by Postgres with CURRENT_DATE, so "today" has
    // to be asked of Postgres too. Building a local midnight in JS and
    // comparing it to a DATE column resolves to the previous day in any
    // timezone ahead of UTC — in IST that meant today's orders never matched
    // and the history was always empty.
    const [{ today }] = await this.prisma.db.$queryRaw<{ today: Date }[]>`
      SELECT CURRENT_DATE AS today
    `;

    return this.prisma.db.order.findMany({
      where: {
        businessId,
        ...(scope === "open"
          ? { status: { in: OPEN_STATUSES } }
          : { businessDay: today }),
      },
      orderBy: [{ status: "asc" }, { placedAt: "asc" }],
      include: {
        table: { select: { id: true, label: true } },
        items: { orderBy: [{ batch: "asc" }, { createdAt: "asc" }] },
      },
    });
  }

  async setStatus(
    userId: string,
    businessId: string,
    orderId: string,
    next: OrderStatus,
  ) {
    await this.businesses.assertOwns(userId, businessId);

    const order = await this.prisma.db.order.findFirst({
      where: { id: orderId, businessId },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundException("Order not found");

    // A finished order stays finished. Reopening one would put two open orders
    // on a table that has since seated new diners.
    if (!ALLOWED_TRANSITIONS[order.status].includes(next)) {
      throw new ConflictException(
        `An order that is ${order.status} cannot be moved to ${next}`,
      );
    }

    return this.prisma.db.order.update({
      where: { id: orderId },
      data: {
        status: next,
        completedAt:
          next === "completed" || next === "cancelled" ? new Date() : null,
      },
      include: {
        table: { select: { id: true, label: true } },
        items: { orderBy: [{ batch: "asc" }, { createdAt: "asc" }] },
      },
    });
  }
}

export interface TableContext {
  tableId: string;
  tableLabel: string;
  isActive: boolean;
  businessId: string;
  businessName: string;
  publicCode: string;
  currency: string;
}

export interface ResolvedTable {
  tableId: string;
  tableLabel: string;
  businessId: string;
  businessName: string;
  publicCode: string;
}
