import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import type { RequestUser } from "../auth/jwt.strategy";
import { CurrentUser } from "../common/decorators";
import { ZodBody } from "../common/zod.pipe";
import { NotificationsService } from "./notifications.service";

/**
 * How many notifications one read returns.
 *
 * Generous, because the common case is a catch-up after a device slept and
 * the client would otherwise page through a night's orders. Bounded, because
 * `since=0` on a year-old restaurant must not try to serialise everything.
 */
const PAGE = 100;

const readSchema = z.object({
  /** Omitted means "everything unread" — the Mark all read button. */
  ids: z.array(z.number().int().positive()).max(500).optional(),
});

const pushSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
  userAgent: z.string().max(512).optional(),
});

const unsubscribeSchema = z.object({ endpoint: z.string().url().max(2048) });

@Controller("businesses/:bid/notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /**
   * The dashboard's one bootstrap call: the notifications themselves, the
   * unread count, the cursor to resume from, the Realtime topic to listen
   * on, and the key needed to subscribe to push.
   *
   * Bundled deliberately. Every one of those is needed before the bell can
   * render anything, and four round trips to a database ~400ms away is a
   * visible pause on a screen that is supposed to feel instant.
   */
  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Query("since") since?: string,
  ) {
    return this.notifications.list(user.id, bid, parseCursor(since), PAGE);
  }

  @Post("read")
  markRead(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Body(new ZodBody(readSchema)) body: z.infer<typeof readSchema>,
  ) {
    return this.notifications.markRead(user.id, bid, body.ids ?? []);
  }

  /**
   * Registers this browser for push. Scoped to the user rather than the
   * business: the subscription belongs to a device someone signed in on, and
   * an owner with two restaurants has one device, not two.
   */
  @Post("push")
  async registerPush(
    @CurrentUser() user: RequestUser,
    @Body(new ZodBody(pushSchema)) body: z.infer<typeof pushSchema>,
  ) {
    await this.notifications.registerPush(user.id, {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent: body.userAgent,
    });
    return { ok: true };
  }

  @Post("push/remove")
  async removePush(
    @CurrentUser() user: RequestUser,
    @Body(new ZodBody(unsubscribeSchema)) body: z.infer<typeof unsubscribeSchema>,
  ) {
    await this.notifications.removePush(user.id, body.endpoint);
    return { ok: true };
  }
}

/**
 * A missing or unusable cursor means "give me the latest page", not "start
 * from zero" — a client that sends nonsense should see a sane inbox rather
 * than a year of history.
 */
function parseCursor(since: string | undefined): bigint | null {
  if (!since) return null;
  try {
    const value = BigInt(since);
    return value >= 0n ? value : null;
  } catch {
    return null;
  }
}
