import { Injectable, Logger } from "@nestjs/common";
import { BusinessesService } from "../businesses/businesses.service";
import { loadEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContext } from "../prisma/tenant-context";
import { businessChannel, tableChannel } from "./channel-name";
import {
  cancellationNotificationCopy,
  staffNotificationCopy,
  summariseNewestRound,
  type CancellationSummary,
  type PlacedOrder,
} from "./events";
import { RealtimeBroadcaster } from "./realtime.broadcast";
import { WebPushSender, type PushTarget } from "./web-push.sender";
import { redactMoneyFromText, stripPrices } from "../orders/kitchen-shape";
import { cursorFor, pendingFor, visibleTo } from "./visibility";
import type { AccessRole } from "@menu/shared";

export interface NotificationView {
  id: number;
  kind: string;
  title: string;
  body: string;
  /** Structured facts the UI renders directly, so it never parses `title`. */
  data: { dailyNumber?: number; tableLabel?: string };
  orderId: string | null;
  tableId: string | null;
  createdAt: string;
  readAt: string | null;
}

/** What `emit_staff_notification` hands back, in one round trip. */
interface EmitResult {
  notification: {
    id: string;
    kind: string;
    title: string;
    body: string;
    orderId: string | null;
    tableId: string | null;
    createdAt: string;
  };
  subscriptions: PushTarget[];
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly env = loadEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContext,
    private readonly businesses: BusinessesService,
    private readonly realtime: RealtimeBroadcaster,
    private readonly push: WebPushSender,
  ) {}

  // ── Emission ──────────────────────────────────────────────────────────────

  /**
   * Announces a round to staff: stores it, pings the business topic, pushes
   * to the owner's devices.
   *
   * Never throws. The order is already committed by the time this runs and a
   * diner is watching a spinner — failing their request because a push
   * service was slow would turn a missed chime into a meal they believe did
   * not go through.
   */
  async announceRound(
    businessId: string,
    tableId: string,
    order: PlacedOrder,
  ): Promise<void> {
    try {
      const round = summariseNewestRound(order);
      if (!round) return;

      const { title, body } = staffNotificationCopy(round.kind, round.summary);

      const emitted = await this.tenant.withoutTenant(async (db) => {
        // SECURITY DEFINER: this runs on a diner's request, which has no
        // app.current_user_id, so RLS correctly refuses an ordinary insert.
        const rows = await db.$queryRaw<{ emit_staff_notification: EmitResult }[]>`
          SELECT emit_staff_notification(
            ${businessId}::uuid,
            ${order.id}::uuid,
            ${tableId}::uuid,
            ${round.kind}::text,
            ${title}::text,
            ${body}::text,
            ${JSON.stringify({
              dailyNumber: round.summary.dailyNumber,
              tableLabel: round.summary.tableLabel,
            })}::jsonb
          ) AS emit_staff_notification
        `;
        return rows[0]?.emit_staff_notification ?? null;
      });

      if (!emitted) return;

      // Independent, so neither waits on the other.
      await Promise.all([
        this.realtime.ping(businessChannel(businessId, this.env.REALTIME_CHANNEL_SECRET), {
          cursor: Number(emitted.notification.id),
        }),
        this.deliverPush(emitted),
      ]);
    } catch (err) {
      this.logger.error(
        `Could not announce a round for business ${businessId}: ${describe(err)}`,
      );
    }
  }

  /**
   * Announces a cancellation to staff, and to the table's own screen.
   *
   * Unlike a status change this one is stored, because it is the only
   * notification that can arrive while the dish is already on the hob. Staff
   * who were away from the board for two minutes still need to find out, and
   * a ping with nothing behind it would leave no trace to find.
   *
   * Swallows its own failures for the same reason announceRound does: the
   * cancellation is committed by the time this runs, and a slow push service
   * must not turn it into an error the diner reads as "it did not work".
   */
  async announceCancellation(
    businessId: string,
    tableId: string,
    orderId: string,
    summary: CancellationSummary,
  ): Promise<void> {
    try {
      const { kind, title, body } = cancellationNotificationCopy(summary);

      const emitted = await this.tenant.withoutTenant(async (db) => {
        const rows = await db.$queryRaw<{ emit_staff_notification: EmitResult }[]>`
          SELECT emit_staff_notification(
            ${businessId}::uuid,
            ${orderId}::uuid,
            ${tableId}::uuid,
            ${kind}::text,
            ${title}::text,
            ${body}::text,
            ${JSON.stringify({
              dailyNumber: summary.dailyNumber,
              tableLabel: summary.tableLabel,
            })}::jsonb
          ) AS emit_staff_notification
        `;
        return rows[0]?.emit_staff_notification ?? null;
      });

      await Promise.all([
        // The table's own screen too: a second phone at the same table is
        // showing the order this just changed.
        this.realtime.ping(tableChannel(tableId, this.env.REALTIME_CHANNEL_SECRET), {}),
        ...(emitted
          ? [
              this.realtime.ping(
                businessChannel(businessId, this.env.REALTIME_CHANNEL_SECRET),
                { cursor: Number(emitted.notification.id) },
              ),
              this.deliverPush(emitted),
            ]
          : []),
      ]);
    } catch (err) {
      this.logger.error(
        `Could not announce a cancellation for business ${businessId}: ${describe(err)}`,
      );
    }
  }

  /**
   * Tells one table its order moved.
   *
   * Nothing is stored. A diner needs their current order, not a history, and
   * `get_table_order` already returns exactly that — so the ping is the whole
   * message and their screen refetches what it was already polling for.
   */
  async announceStatus(tableId: string): Promise<void> {
    try {
      await this.realtime.ping(
        tableChannel(tableId, this.env.REALTIME_CHANNEL_SECRET),
        {},
      );
    } catch (err) {
      this.logger.warn(`Could not announce status to table ${tableId}: ${describe(err)}`);
    }
  }

  /**
   * Wakes the staff feed without storing anything.
   *
   * Putting an order on the kitchen's board writes no notification of its
   * own — the row that describes it was written when the diner placed it.
   * What the move changes is who may read that row: it is hidden from the
   * kitchen until then (see notifications/visibility.ts). Without this ping
   * the kitchen's bell would only discover it on the next unrelated event,
   * which on a quiet evening is the order after it — far too late to be a
   * notification.
   *
   * Warn, never throw: the status change is already committed and the person
   * who made it is watching a button.
   */
  async announceReachedKitchen(businessId: string): Promise<void> {
    try {
      await this.realtime.ping(
        businessChannel(businessId, this.env.REALTIME_CHANNEL_SECRET),
        {},
      );
    } catch (err) {
      this.logger.warn(
        `Could not wake the staff feed for business ${businessId}: ${describe(err)}`,
      );
    }
  }

  private async deliverPush(emitted: EmitResult): Promise<void> {
    const { dead } = await this.push.send(emitted.subscriptions, {
      id: emitted.notification.id,
      title: emitted.notification.title,
      body: emitted.notification.body,
      url: "/orders",
    });

    if (dead.length === 0) return;

    // Outside any tenant: this runs on the diner's request, which carries no
    // user id, and these rows were named dead by the push service itself
    // rather than chosen by anyone.
    await this.tenant.withoutTenant(async (db) => {
      await db.$executeRaw`
        DELETE FROM push_subscriptions WHERE endpoint = ANY(${dead}::text[])
      `;
    });
    this.logger.log(`Pruned ${dead.length} dead push subscription(s)`);
  }

  // ── Reads, for the dashboard ──────────────────────────────────────────────

  /**
   * Everything newer than the client's cursor.
   *
   * This is what makes the socket optional. Subscribe, reconnect, tab focus
   * and the fallback poll all land here, so a ping that never arrived costs
   * latency and nothing else.
   */
  async list(
    userId: string,
    businessId: string,
    since: bigint | null,
    limit: number,
  ): Promise<{
    items: NotificationView[];
    unread: number;
    cursor: number;
    channel: string;
    pushPublicKey: string;
  }> {
    const { role } = await this.businesses.assertAccess(userId, businessId, {
      allow: ["owner", "kitchen"],
    });

    const since_ = await this.feedFloor(role, businessId, userId);
    const visible = visibleTo(role, businessId, since_);
    const pending = pendingFor(role, businessId, since_);

    const [rows, unread, newest, oldestPending] = await Promise.all([
      this.prisma.db.notification.findMany({
        where: { ...visible, ...(since !== null && { id: { gt: since } }) },
        orderBy: { id: "desc" },
        take: limit,
      }),
      this.prisma.db.notification.count({ where: { ...visible, readAt: null } }),
      this.prisma.db.notification.findFirst({
        where: visible,
        orderBy: { id: "desc" },
        select: { id: true },
      }),
      // Oldest first: the cursor has to stop below the *earliest* row still
      // waiting on an accept, not the latest.
      pending
        ? this.prisma.db.notification.findFirst({
            where: pending,
            orderBy: { id: "asc" },
            select: { id: true },
          })
        : null,
    ]);

    return stripPrices(
      {
        items: rows.map(toView).map((n) => redactNotificationMoney(n, role)),
        unread,
        cursor: cursorFor(
          newest ? Number(newest.id) : 0,
          oldestPending ? Number(oldestPending.id) : null,
        ),
        channel: businessChannel(businessId, this.env.REALTIME_CHANNEL_SECRET),
        pushPublicKey: this.env.VAPID_PUBLIC_KEY,
      },
      role,
    );
  }

  /** Marks the named notifications read, or all of them when none are named. */
  async markRead(
    userId: string,
    businessId: string,
    ids: number[],
  ): Promise<{ unread: number }> {
    const { role } = await this.businesses.assertAccess(userId, businessId, {
      allow: ["owner", "kitchen"],
    });

    const visible = visibleTo(
      role,
      businessId,
      await this.feedFloor(role, businessId, userId),
    );

    await this.prisma.db.notification.updateMany({
      // Scoped to what this reader can actually see, not just to the ids they
      // sent — which came from a client, and which RLS alone would let an
      // owner's "mark all" apply venue-wide. For the kitchen the scoping is
      // load-bearing: marking a still-hidden row read would hand it over
      // already-acknowledged once the order was accepted, so it would never
      // chime and never raise the badge. A silently dropped order.
      where: {
        ...visible,
        readAt: null,
        ...(ids.length > 0 && { id: { in: ids.map((n) => BigInt(n)) } }),
      },
      data: { readAt: new Date() },
    });

    const unread = await this.prisma.db.notification.count({
      where: { ...visible, readAt: null },
    });
    return stripPrices({ unread }, role);
  }

  /**
   * The earliest notification a reader is entitled to, or null for all of them.
   *
   * Staff see the service they are working, not the venue's history.
   * Notifications are business-scoped, so without this a kitchen member who
   * started this morning opens the bell to a week of other people's rounds —
   * noise they cannot act on, about tables that have long since paid and
   * left. Their own start date is the only sensible floor, and it is already
   * on the row that grants them access.
   *
   * Owners keep the full history: it is their venue.
   *
   * A staff row that has gone missing between the access check and here
   * floors the feed at *now* rather than opening it: the safe direction for
   * a question we cannot answer is fewer notifications, not all of them.
   */
  private async feedFloor(
    role: AccessRole,
    businessId: string,
    userId: string,
  ): Promise<Date | null> {
    if (role === "owner") return null;
    const staff = await this.prisma.db.businessStaff.findFirst({
      where: { businessId, userId, status: "active" },
      select: { createdAt: true },
    });
    return staff?.createdAt ?? new Date();
  }

  // ── Push subscriptions ────────────────────────────────────────────────────

  async registerPush(
    userId: string,
    sub: { endpoint: string; p256dh: string; auth: string; userAgent?: string },
  ): Promise<void> {
    // Keyed on the endpoint: a browser that re-subscribes must update its
    // row, not add a second one that delivers every order twice.
    await this.prisma.db.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: {
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.p256dh,
        auth: sub.auth,
        userAgent: sub.userAgent ?? null,
      },
      update: {
        userId,
        p256dh: sub.p256dh,
        auth: sub.auth,
        lastSeenAt: new Date(),
      },
    });
  }

  async removePush(userId: string, endpoint: string): Promise<void> {
    await this.prisma.db.pushSubscription.deleteMany({ where: { userId, endpoint } });
  }
}

/**
 * Blanks the money a notification's rendered sentence carries, for a reader
 * who is not allowed to see it.
 *
 * `stripPrices` works on keys; `title` and `body` are prose composed at emit
 * time with the total already interpolated, so only the text itself can be
 * cleaned. See redactMoneyFromText for why this happens at read time.
 */
function redactNotificationMoney(
  n: NotificationView,
  role: AccessRole,
): NotificationView {
  if (role === "owner") return n;
  return {
    ...n,
    title: redactMoneyFromText(n.title),
    body: redactMoneyFromText(n.body),
  };
}

function toView(row: {
  id: bigint;
  kind: string;
  title: string;
  body: string;
  data: unknown;
  orderId: string | null;
  tableId: string | null;
  createdAt: Date;
  readAt: Date | null;
}): NotificationView {
  return {
    // Narrowed at the boundary. The column is a bigserial because the
    // counter is global across tenants; a JS number is exact far past
    // anything it will reach, and BigInt does not survive JSON.
    id: Number(row.id),
    kind: row.kind,
    title: row.title,
    body: row.body,
    data: (row.data ?? {}) as NotificationView["data"],
    orderId: row.orderId,
    tableId: row.tableId,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
