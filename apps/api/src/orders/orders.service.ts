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
import { NotificationsService } from "../notifications/notifications.service";
import type { CancelledLine, PlacedOrder } from "../notifications/events";
import type { CancelOrderInput } from "@menu/shared";
import { ALLOWED_TRANSITIONS, OPEN_STATUSES } from "./transitions";

export interface PlaceLine {
  itemId: string;
  variantId?: string | null;
  quantity: number;
}

/** What `cancel_table_order` hands back, in the one round trip. */
export interface CancellationResult {
  orderId: string;
  /** True when nothing was left, so the order itself is cancelled too. */
  orderCancelled: boolean;
  dailyNumber: number;
  tableLabel: string;
  currency: string;
  reason: CancelOrderInput["reason"];
  remark: string | null;
  lines: CancelledLine[];
  /** The order as it now stands, or null once it is cancelled outright. */
  order: PlacedOrder | null;
}


@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businesses: BusinessesService,
    private readonly tenant: TenantContext,
    private readonly notifications: NotificationsService,
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
  ): Promise<PlacedOrder | null> {
    if (lines.length === 0) throw new BadRequestException("Add something first");

    const payload = JSON.stringify(
      lines.map((l) => ({
        itemId: l.itemId,
        variantId: l.variantId ?? null,
        quantity: l.quantity,
      })),
    );

    const order = await this.tenant.withoutTenant(async (db) => {
      try {
        const rows = await db.$queryRaw<
          { place_table_round: PlacedOrder | null }[]
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

    // Awaited, not fired and forgotten. On a serverless runtime the instance
    // can be frozen the moment the response is written, so work left running
    // past that point is not slow — it simply never happens. The method
    // swallows its own failures, so this cannot cost the diner their order.
    if (order) await this.notifications.announceRound(businessId, tableId, order);

    return order;
  }

  /**
   * Cancels a diner's whole order, or some units of some of its lines.
   *
   * Every rule the owner set — the switch, the window, which statuses still
   * allow it, whether single dishes may go at all — is checked inside
   * `cancel_table_order`, against that transaction's own clock and the
   * settings as they are at that instant. Nothing sent from the phone is
   * load-bearing: the deadlines it was given are there so it can hide a
   * button that would fail, not so it can decide the answer.
   *
   * The same advisory lock `place_table_round` takes serialises this against
   * a round arriving on the same table.
   */
  async cancelForTable(
    businessId: string,
    tableId: string,
    input: CancelOrderInput,
  ): Promise<CancellationResult> {
    const lines = input.lines
      ? JSON.stringify(
          input.lines.map((l) => ({
            orderItemId: l.orderItemId,
            quantity: l.quantity,
          })),
        )
      : null;

    const result = await this.tenant.withoutTenant(async (db) => {
      try {
        const rows = await db.$queryRaw<
          { cancel_table_order: CancellationResult }[]
        >`SELECT cancel_table_order(${tableId}::uuid, ${lines}::jsonb, ${input.reason}::text, ${
          input.remark ?? null
        }::text) AS cancel_table_order`;
        return rows[0]?.cancel_table_order ?? null;
      } catch (err) {
        // The function raises check_violation for everything a diner could
        // have done differently — too late, already being made, cancelling
        // more than they ordered. Those are 400s carrying the message as
        // written, because the message is the whole answer.
        const message = err instanceof Error ? err.message : "";
        const match = /ERROR: (.+)/.exec(message);
        if (match) throw new BadRequestException(cleanPgMessage(match[1]!));
        throw err;
      }
    });

    if (!result) throw new NotFoundException("You have no open order");

    // Awaited rather than fired and forgotten: on a serverless runtime the
    // instance can be frozen the moment the response is written. This is the
    // one notification the kitchen may be mid-dish for, so losing it is worse
    // than the milliseconds it costs.
    await this.notifications.announceCancellation(
      businessId,
      tableId,
      result.orderId,
      {
        tableLabel: result.tableLabel,
        dailyNumber: result.dailyNumber,
        currency: result.currency,
        orderCancelled: result.orderCancelled,
        lines: result.lines,
        reason: result.reason,
        remark: result.remark,
      },
    );

    return result;
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
      // Running orders first. The board groups by status in the browser, so
      // the effect is that a table that has come back sits at the top of
      // whichever column it is in rather than behind tables seated after it.
      orderBy: [{ isRunning: "desc" }, { status: "asc" }, { placedAt: "asc" }],
      include: {
        table: { select: { id: true, label: true } },
        items: { orderBy: [{ batch: "asc" }, { createdAt: "asc" }] },
        // A cancelled line is deleted from `items` outright, so without this
        // the board would show an order quietly shrinking with no account of
        // why — and staff would go on cooking what is no longer there.
        cancellations: { orderBy: { createdAt: "asc" } },
      },
    });
  }

  /**
   * One order's timeline.
   *
   * A route of its own rather than a field on the board's response. The board
   * polls both scopes every five seconds; embedding six-ish rows per order in
   * both, forever, to fill a panel that is collapsed by default is a poor
   * trade. This is called when a card is expanded and after it advances.
   */
  async listEvents(userId: string, businessId: string, orderId: string) {
    await this.businesses.assertOwns(userId, businessId);

    const order = await this.prisma.db.order.findFirst({
      where: { id: orderId, businessId },
      select: { id: true },
    });
    if (!order) throw new NotFoundException("Order not found");

    const events = await this.prisma.db.orderEvent.findMany({
      where: { orderId },
      // By id, not by `at`: two events in the same millisecond must still
      // render in the order they happened.
      orderBy: { id: "asc" },
    });

    // BigInt does not survive JSON.stringify, and the id is only ever a React
    // key on the way out.
    return events.map((e) => ({
      id: Number(e.id),
      kind: e.kind,
      at: e.at.toISOString(),
      data: e.data,
    }));
  }

  /**
   * Staff's override on the running-order flag.
   *
   * Per order, not per table. Clearing table 5's flag says "this one is
   * wrong", not "never flag table 5 again" — a table-level mute would be a
   * second piece of state with its own lifetime and no obvious end, and the
   * next party seated there would inherit it.
   *
   * Open orders only. A served order's flag is a record of what was true
   * when it arrived, and the same reasoning that stops `setStatus` reopening
   * a completed order stops this rewriting one.
   *
   * No notification: this is staff correcting their own board, and the diner
   * was never told about the flag in the first place.
   */
  async setRunning(
    userId: string,
    businessId: string,
    orderId: string,
    running: boolean,
  ) {
    await this.businesses.assertOwns(userId, businessId);

    const order = await this.prisma.db.order.findFirst({
      where: { id: orderId, businessId },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundException("Order not found");

    if (!OPEN_STATUSES.includes(order.status)) {
      throw new ConflictException(
        `An order that is ${order.status} can no longer be changed`,
      );
    }

    return this.prisma.db.order.update({
      where: { id: orderId },
      data: { isRunning: running },
      include: {
        table: { select: { id: true, label: true } },
        items: { orderBy: [{ batch: "asc" }, { createdAt: "asc" }] },
        cancellations: { orderBy: { createdAt: "asc" } },
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

    const updated = await this.prisma.db.order.update({
      where: { id: orderId },
      data: {
        status: next,
        completedAt:
          next === "completed" || next === "cancelled" ? new Date() : null,
      },
      include: {
        table: { select: { id: true, label: true } },
        items: { orderBy: [{ batch: "asc" }, { createdAt: "asc" }] },
        cancellations: { orderBy: { createdAt: "asc" } },
      },
    });

    // The diner's screen is listening on its table's topic. Nothing is
    // stored for them: they need the order's current state, which
    // get_table_order already returns, not a log of how it got there.
    await this.notifications.announceStatus(updated.tableId);

    return updated;
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
