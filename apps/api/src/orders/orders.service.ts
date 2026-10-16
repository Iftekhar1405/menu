import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { KITCHEN_BOARD } from "../notifications/visibility";
import type { AccessRole, CancelOrderInput } from "@menu/shared";
import {
  ALLOWED_TRANSITIONS,
  OPEN_STATUSES,
  canRoleSetStatus,
  canTransition,
} from "./transitions";
import { stripPrices } from "./kitchen-shape";

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
    const { role } = await this.businesses.assertAccess(userId, businessId, {
      allow: ["owner", "kitchen"],
    });

    // `business_day` is written by Postgres with CURRENT_DATE, so "today" has
    // to be asked of Postgres too. Building a local midnight in JS and
    // comparing it to a DATE column resolves to the previous day in any
    // timezone ahead of UTC — in IST that meant today's orders never matched
    // and the history was always empty.
    const [{ today }] = await this.prisma.db.$queryRaw<{ today: Date }[]>`
      SELECT CURRENT_DATE AS today
    `;

    const orders = await this.prisma.db.order.findMany({
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
        // The board prints and advances one round at a time, so it needs the
        // rounds themselves — each with its own status and KOT number, which
        // a flattened item list cannot carry.
        rounds: {
          orderBy: { seq: "asc" },
          include: { items: { orderBy: { createdAt: "asc" } } },
        },
        // The flat list stays: every existing reader of this payload still
        // uses it. Ordering by createdAt alone is round order — a round's
        // items are written in one statement, after every item of the round
        // before it — so the join back to order_rounds buys nothing here.
        items: { orderBy: { createdAt: "asc" } },
        // A cancelled line is deleted from `items` outright, so without this
        // the board would show an order quietly shrinking with no account of
        // why — and staff would go on cooking what is no longer there.
        cancellations: { orderBy: { createdAt: "asc" } },
      },
    });

    return stripPrices(orders, role);
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
    const { role } = await this.businesses.assertAccess(userId, businessId, {
      allow: ["owner", "kitchen"],
    });

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
    const mapped = events.map((e) => ({
      id: Number(e.id),
      kind: e.kind,
      at: e.at.toISOString(),
      data: e.data,
      actorId: e.actorId,
    }));

    return stripPrices(mapped, role);
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

    await this.prisma.db.order.update({
      where: { id: orderId },
      data: { isRunning: running },
    });

    // `assertOwns` above admits owners and nobody else, so the role is not in
    // doubt here. Named rather than inferred so the strip is visible at every
    // call site: the day this route is opened to the kitchen, this line is
    // what has to change, in the same edit.
    return this.orderForBoard(businessId, orderId, "owner");
  }

  /**
   * One order in the shape the staff board draws.
   *
   * A read rather than an `include` on the write it follows, because the
   * write is no longer the whole story: moving a round leaves the order's own
   * status to an AFTER trigger, and anything returned by the UPDATE that
   * caused it would carry the status from before the trigger ran.
   *
   * Stripped here, for the same reason stripPrices exists at all: this
   * include is the same shape `listForBusiness` strips, and it is handed
   * straight back by three mutating methods a kitchen account may call. A
   * response that has left the server has leaked whatever is in it, whatever
   * the browser then chooses to render — so the strip belongs at the one
   * place all three share, not at each of them.
   */
  private async orderForBoard(
    businessId: string,
    orderId: string,
    role: AccessRole,
  ) {
    const order = await this.prisma.db.order.findFirstOrThrow({
      where: { id: orderId, businessId },
      include: {
        table: { select: { id: true, label: true } },
        rounds: {
          orderBy: { seq: "asc" },
          include: { items: { orderBy: { createdAt: "asc" } } },
        },
        items: { orderBy: { createdAt: "asc" } },
        cancellations: { orderBy: { createdAt: "asc" } },
      },
    });

    return stripPrices(order, role);
  }

  /**
   * Moves the whole table along — and, at `completed`, closes it.
   *
   * Still the board's one-tap action on an order card, so it keeps its route
   * and its signature. What changed underneath is who writes `orders.status`:
   * nobody here. The column is derived from the rounds by trigger, so this
   * method moves the rounds and lets the derivation follow. Writing it here
   * as well was two authors for one fact — and the hand-written value was not
   * even the one that lasted, since the next round to move silently replaced
   * it with what the rounds actually said.
   *
   * That makes closing a table literally that: finish everything still live
   * on it. A single round left behind holds the order open through the
   * derivation, and the table the owner just settled reappears on the board.
   */
  async setStatus(
    userId: string,
    businessId: string,
    orderId: string,
    next: OrderStatus,
  ) {
    const { role } = await this.businesses.assertAccess(userId, businessId, {
      allow: ["owner", "kitchen"],
    });

    const order = await this.prisma.db.order.findFirst({
      where: { id: orderId, businessId },
      select: { id: true, status: true },
    });
    if (!order) throw new NotFoundException("Order not found");

    // A finished order stays finished. Reopening one would put two open orders
    // on a table that has since seated new diners.
    //
    // Two different refusals on purpose. The state machine refusing is a
    // fact about the order and reads as 409; a role refusing is a fact about
    // the person and reads as 403. Collapsing them would tell a kitchen user
    // their order was in the wrong state when it was not.
    if (!ALLOWED_TRANSITIONS[order.status].includes(next)) {
      throw new ConflictException(
        `An order that is ${order.status} cannot be moved to ${next}`,
      );
    }
    if (!canRoleSetStatus(role, order.status, next)) {
      throw new ForbiddenException(`You cannot move an order to ${next}`);
    }

    // Which live rounds this move actually applies to.
    //
    // A round already at or past `next` is left where it is, not refused. The
    // order's status is its LEAST advanced live round, so a table reading
    // "Being made" can already hold a round that is ready; tapping Ready on
    // it is a legal move on the order and a no-op on that round. Refusing the
    // whole call because one round had nowhere left to go would make exactly
    // the multi-round table this feature exists for unservable. Closing a
    // table is the case where nothing is excluded: every live status can
    // reach `completed`.
    //
    // Terminal rounds are out of it entirely, which is the other half of the
    // same rule — a chai cancelled an hour ago is not completed when the
    // table is.
    const movable = OPEN_STATUSES.filter((from) => canTransition(from, next));

    // One statement, not a read followed by an update each. It is the same
    // set either way — the filter above is the state machine, which is the
    // same thing the per-round check would have asked — and the round trips
    // a staff board makes over a hotel's wifi are the budget that matters
    // here (see TENANT_TX_TIMEOUT_MS). Atomic without asking for it either:
    // the whole request already runs inside the transaction TenantInterceptor
    // opened, and prisma.db is that transaction's client — which is why it
    // has no $transaction of its own to wrap this in.
    //
    // No role check beyond the one already made on the order.
    // `canRoleSetStatus` is `canTransition` and ROLE_TARGETS together; the
    // filter above has settled the first for every round this touches, and
    // the second asks only about `next` and the person, neither of which
    // varies from one round to the next.
    const { count } = await this.prisma.db.orderRound.updateMany({
      where: { orderId, businessId, status: { in: movable } },
      data: {
        status: next,
        // `undefined`, not null, for the same reason as setRoundStatus: a
        // timestamp this move did not produce is left out of the UPDATE
        // rather than overwritten. It is also what keeps a kitchen move
        // legal — order_rounds_kitchen_guard compares completed_at and raises
        // 42501 on a staff write that changes it, and `new Date()` always
        // would.
        acceptedAt: next === "accepted" ? new Date() : undefined,
        completedAt:
          next === "completed" || next === "cancelled" ? new Date() : undefined,
      },
    });

    // Nothing moved, so no trigger fired, so the order's status is wherever it
    // already was — and the caller would otherwise be told 200, which is
    // indistinguishable from having worked. On healthy data this cannot
    // happen: the order's status IS its least advanced live round, that round
    // sits at a status the guard above has just proved can reach `next`, and
    // so it is in `movable`. It can happen on a row the hand-write this method
    // used to do left divergent — a live `orders.status` over rounds that are
    // all terminal, which the derivation would never produce. Such an order
    // can never be closed, and `orders_one_open_per_table` then blocks the
    // table taking any new order at all. Loud, with the id in it, beats a
    // table that silently stops working and no line anywhere saying why.
    if (count === 0) {
      throw new ConflictException(
        `Order ${orderId} has no live round to move to ${next}; its status disagrees with its rounds`,
      );
    }

    const updated = await this.orderForBoard(businessId, orderId, role);

    // The diner's screen is listening on its table's topic. Nothing is
    // stored for them: they need the order's current state, which
    // get_table_order already returns, not a log of how it got there.
    await this.notifications.announceStatus(updated.tableId);

    // Leaving `placed` is the moment this order becomes the kitchen's. Their
    // bell has been holding the diner's "New order" row back until now, so it
    // needs telling — nothing else on this path reaches the staff topic.
    // Keyed on the move out of `placed` rather than on `accepted` alone,
    // because the state machine lets an owner skip straight to `preparing`.
    //
    // Against the derived status rather than the one asked for, as
    // setRoundStatus does: where the order ended up is something the
    // derivation decided from every round, and it is what the kitchen's board
    // filter and RLS will go on. `next` is only what was requested.
    if (order.status === "placed" && KITCHEN_BOARD.includes(updated.status)) {
      await this.notifications.announceReachedKitchen(businessId);
    }

    return updated;
  }

  /**
   * Moves one round along.
   *
   * The order's own status is not written here — the derivation trigger does
   * it, atomically, from every round. Writing both would be two authors for
   * one fact, and they would disagree the first time two rounds moved at
   * once.
   */
  async setRoundStatus(
    userId: string,
    businessId: string,
    orderId: string,
    roundId: string,
    next: OrderStatus,
  ) {
    const { role } = await this.businesses.assertAccess(userId, businessId, {
      allow: ["owner", "kitchen"],
    });

    // The order's status comes back on the same read: it is what the kitchen
    // bell below is keyed on, and asking for it after the write would be
    // asking for the derived value, which is the thing being compared against.
    const round = await this.prisma.db.orderRound.findFirst({
      where: { id: roundId, orderId, businessId },
      select: {
        id: true,
        status: true,
        seq: true,
        order: { select: { status: true } },
      },
    });
    if (!round) throw new NotFoundException("Round not found");

    // The same two refusals, for the same two reasons, as setStatus: the
    // state machine refusing is a fact about the round and reads as 409; a
    // role refusing is a fact about the person and reads as 403.
    if (!ALLOWED_TRANSITIONS[round.status].includes(next)) {
      throw new ConflictException(
        `Round ${round.seq} is ${round.status} and cannot be moved to ${next}`,
      );
    }
    if (!canRoleSetStatus(role, round.status, next)) {
      throw new ForbiddenException(`You cannot move a round to ${next}`);
    }

    await this.prisma.db.orderRound.update({
      where: { id: roundId },
      data: {
        status: next,
        // `undefined`, not null: a timestamp this move did not produce is
        // left out of the UPDATE entirely rather than overwritten with null.
        // A round that is accepted, then started, keeps the minute it was
        // accepted — which is the only thing accepted_at is for.
        acceptedAt: next === "accepted" ? new Date() : undefined,
        completedAt:
          next === "completed" || next === "cancelled" ? new Date() : undefined,
      },
    });

    const updated = await this.orderForBoard(businessId, orderId, role);

    // Unconditionally, not only when the order's derived status moved. The
    // diner's payload carries the rounds themselves now — "the chai is ready,
    // the dosa is not" — so accepting KOT 1 while KOT 2 is still waiting
    // changes their screen without changing the order's status at all. Gating
    // this on the derived status would leave them staring at a stale screen
    // in precisely the multi-round case this whole feature exists for. The
    // ping stores nothing, carries nothing, and swallows its own failures, so
    // the cost of one the diner did not strictly need is nil.
    await this.notifications.announceStatus(updated.tableId);

    // The bell is a different matter, and stays conditional. It releases a
    // notification row that is hidden from the kitchen until the ORDER
    // reaches their board, so the thing it must key on is the order's status
    // leaving `placed` — which here is something the derivation trigger
    // decided, not something this method chose.
    if (round.order.status === "placed" && KITCHEN_BOARD.includes(updated.status)) {
      await this.notifications.announceReachedKitchen(businessId);
    }

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
