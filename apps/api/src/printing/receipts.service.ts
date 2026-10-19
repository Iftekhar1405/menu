import { Injectable } from "@nestjs/common";
import { jobsForEvent, type PrintJob } from "@menu/shared";
import { loadEnv, usesRealtime } from "../config/env";
import { businessChannel } from "../notifications/channel-name";
import { PrismaService } from "../prisma/prisma.service";
import { StationsService } from "./stations.service";

/**
 * How far back a station will print without being asked.
 *
 * A machine switched off all day and opened at closing time must not emit
 * two hundred tickets. Everything older than this is listed as missed and
 * waits for someone to decide it still matters.
 */
const WINDOW_MINUTES = 30;

/** How far back the missed list looks. A shift, not a history. */
const MISSED_HOURS = 16;

export interface PendingJob {
  /** order_events.id as a string: it is a bigint, and JSON has no such thing. */
  eventId: string;
  job: PrintJob;
  kind: string;
  at: string;
  orderId: string;
  tableLabel: string;
  token: number;
}

@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stations: StationsService,
  ) {}

  /**
   * What this station has a printer for and has not already taken.
   *
   * Deliberately side-effect free apart from the last-seen touch, so two
   * tabs asking at the same moment is harmless — the race is resolved by
   * the unique index at the claim, not by trying to prevent it here.
   *
   * The mapping from event to job is `jobsForEvent`, the same function the
   * station page uses, so the API cannot offer a job the page would not
   * know how to render.
   *
   * `now` is a parameter so the window is testable. Production passes
   * nothing.
   */
  async pending(
    userId: string,
    businessId: string,
    stationId: string,
    now: Date = new Date(),
  ): Promise<{ pending: PendingJob[]; missed: PendingJob[]; topic: string | null }> {
    const station = await this.stations.resolve(userId, businessId, stationId, { touch: true });

    // The topic the page may listen on. Derived here and handed over, never
    // derived in the browser — a leaked business id must not yield a
    // subscription to that restaurant's activity.
    // `usesRealtime`, not a truthiness test on the secret: the secret has a
    // dev default in env.ts and is therefore never falsy, so checking it
    // would make the null branch dead code. What actually decides whether a
    // topic is worth having is whether anything will ever broadcast to it —
    // the same condition RealtimeBroadcaster.ping checks before sending.
    const env = loadEnv();
    const topic = usesRealtime(env)
      ? businessChannel(businessId, env.REALTIME_CHANNEL_SECRET)
      : null;

    const jobs = new Set<PrintJob>(station.outputs.map((o) => o.job as PrintJob));
    // No printer on this machine yet: nothing to print, and nothing
    // accumulating either. A venue with no station is simply unaffected.
    if (jobs.size === 0) return { pending: [], missed: [], topic };

    const since = new Date(now.getTime() - MISSED_HOURS * 3_600_000);
    const events = await this.prisma.db.orderEvent.findMany({
      where: { businessId, at: { gte: since } },
      orderBy: { at: "asc" },
      include: { order: { select: { dailyNumber: true, table: { select: { label: true } } } } },
    });

    // Scoped to "not failed" in the query as the normal-case optimisation,
    // but also re-checked below on the rows actually returned — a failed
    // attempt must never count as "already taken", and a query whose WHERE
    // clause silently stopped doing its job must not turn into a ticket that
    // quietly never offers again.
    const taken = await this.prisma.db.printReceipt.findMany({
      where: { stationId, status: { not: "failed" }, event: { at: { gte: since } } },
      select: { eventId: true, job: true, status: true },
    });
    const done = new Set(
      taken.filter((r) => r.status !== "failed").map((r) => `${r.eventId}:${r.job}`),
    );

    const cutoff = now.getTime() - WINDOW_MINUTES * 60_000;
    const pending: PendingJob[] = [];
    const missed: PendingJob[] = [];

    for (const e of events) {
      for (const job of jobsForEvent(e.kind)) {
        if (!jobs.has(job)) continue;
        if (done.has(`${e.id}:${job}`)) continue;

        const row: PendingJob = {
          eventId: String(e.id),
          job,
          kind: e.kind,
          at: e.at.toISOString(),
          orderId: e.orderId,
          tableLabel: e.order.table.label,
          token: e.order.dailyNumber,
        };
        (e.at.getTime() >= cutoff ? pending : missed).push(row);
      }
    }

    return { pending, missed, topic };
  }
}
