import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { jobsForEvent, type PrintJob, type Ticket } from "@menu/shared";
import { loadEnv, usesRealtime } from "../config/env";
import { BillingService } from "../billing/billing.service";
import { businessChannel } from "../notifications/channel-name";
import { PrismaService } from "../prisma/prisma.service";
import { translatePgError } from "./pg-errors";
import { StationsService } from "./stations.service";
import { billTicketFrom, kitchenTicketFrom, tokenTicketFrom } from "./ticket-payload";

/**
 * The one error `claim()` must catch ahead of everything else.
 *
 * `print_receipts_claim_key` is the unique index that makes the insert the
 * claim: when two tabs race, the loser's violation means "someone else took
 * it", not "something is wrong". It must never reach `translatePgError`,
 * whose generic `ERROR:` handler would turn it into a 400 the station page
 * shows as a real failure — see the comment at the call site.
 */
function isClaimConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : "";
  return message.includes("print_receipts_claim_key") || message.includes("23505");
}

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
    private readonly billing: BillingService,
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

  /**
   * Take a job, and get back the paper to print.
   *
   * THE INSERT IS THE CLAIM. Two tabs on one machine both arrive here; the
   * unique index on (station, event, job, attempt) lets one through and
   * the other gets a 409 it treats as "someone else took it". Checking
   * first and inserting second would lose the race it is trying to win.
   *
   * The ticket comes back with the receipt so a station does one round
   * trip per piece of paper. Generating a bill is a side effect, which is
   * why it happens here and not in the side-effect-free `pending`.
   *
   * `paperWidth` is typed `number` here because Prisma types the column a
   * plain smallint; narrowing it to 58 | 80 is sound because
   * `station_outputs_paper_width_check` admits no other value, and that is
   * the whole justification — a future reader does not have to rediscover
   * it by reading the migration.
   */
  async claim(
    userId: string,
    businessId: string,
    stationId: string,
    body: { eventId: string; job: PrintJob; reprint?: boolean },
  ): Promise<{ receiptId: string; attempt: number; paperWidth: number; ticket: Ticket }> {
    const station = await this.stations.resolve(userId, businessId, stationId, { touch: true });

    const output = station.outputs.find((o) => o.job === body.job);
    if (!output) throw new ForbiddenException("This machine has no printer for that job");

    // A bill is prices. The station could only hold a bill output if an
    // owner attached it, but the claim is a second door to the same data
    // and gets the same lock.
    if (body.job === "bill") {
      const role = await this.stations.roleFor(userId, businessId);
      if (role !== "owner") throw new ForbiddenException("Only the owner can print a bill");
    }

    const event = await this.prisma.db.orderEvent.findFirst({
      where: { id: BigInt(body.eventId), businessId },
    });
    if (!event) throw new NotFoundException("Event not found");

    // The mapping is the authority. A client asking for a bill off an
    // accepted round is asking for something that does not exist.
    if (!jobsForEvent(event.kind).includes(body.job)) {
      throw new ForbiddenException("That event does not produce that ticket");
    }

    const attempt = body.reprint ? await this.nextAttempt(stationId, event.id, body.job) : 1;

    let receipt: { id: bigint; attempt: number };
    try {
      // Through claim_print_receipt, not printReceipt.create: there is no
      // kitchen INSERT policy on this table, by the schema-wide invariant
      // asserted in kitchen-policies.spec.ts.
      const rows = await this.prisma.db.$queryRaw<
        { receipt: { id: bigint; attempt: number } }[]
      >`SELECT claim_print_receipt(
          ${businessId}::uuid, ${stationId}::uuid, ${event.id}::bigint,
          ${body.job}::"PrintJob", ${attempt}::int
        ) AS receipt`;
      receipt = rows[0]!.receipt;
    } catch (e) {
      // ORDER MATTERS, and must stay structurally so, not just by
      // convention: the unique violation is checked here, before
      // `translatePgError` ever sees the error. Folding this into that
      // shared translator's generic `ERROR:` handler — the obvious
      // "de-duplicate this" cleanup — would put the race check behind it,
      // which turns a lost race into a 400 the station page shows as a real
      // failure instead of "someone else took it". The isClaimConflict
      // check above exists so this ordering has a name, not just a comment.
      if (isClaimConflict(e)) {
        throw new ConflictException("Another station tab already took this ticket");
      }
      translatePgError(e);
    }

    const ticket = await this.ticketFor(userId, businessId, station, event, body.job);
    return {
      receiptId: String(receipt.id),
      attempt: receipt.attempt,
      paperWidth: output.paperWidth,
      ticket,
    };
  }

  private async nextAttempt(stationId: string, eventId: bigint, job: PrintJob) {
    const last = await this.prisma.db.printReceipt.findFirst({
      where: { stationId, eventId, job },
      orderBy: { attempt: "desc" },
      select: { attempt: true },
    });
    return (last?.attempt ?? 0) + 1;
  }

  private async ticketFor(
    userId: string,
    businessId: string,
    station: { business: { name: string } },
    event: { id: bigint; orderId: string; roundId: string | null },
    job: PrintJob,
  ): Promise<Ticket> {
    if (job === "bill") {
      // generate_bill returns the existing bill rather than recomputing, so
      // a reprint is identical to the original by construction.
      const bill = await this.billing.generate(userId, businessId, event.orderId);
      const order = await this.prisma.db.order.findFirst({
        where: { id: event.orderId, businessId },
        select: { dailyNumber: true },
      });
      if (!order) throw new NotFoundException("Order not found");
      return billTicketFrom(bill, order.dailyNumber);
    }

    if (!event.roundId) throw new NotFoundException("That event has no round");
    const round = await this.prisma.db.orderRound.findFirst({
      where: { id: event.roundId, businessId },
      include: {
        items: { orderBy: { createdAt: "asc" } },
        order: {
          select: { dailyNumber: true, note: true, isRunning: true, table: { select: { label: true } } },
        },
      },
    });
    if (!round) throw new NotFoundException("Round not found");

    const src = {
      businessName: station.business.name,
      order: {
        dailyNumber: round.order.dailyNumber,
        note: round.order.note,
        isRunning: round.order.isRunning ?? false,
        tableLabel: round.order.table.label,
      },
      round: {
        seq: round.seq,
        kotNumber: round.kotNumber,
        placedAt: round.placedAt,
        items: round.items.map((i) => ({
          quantity: i.quantity,
          nameSnapshot: i.nameSnapshot,
          variantSnapshot: i.variantSnapshot,
        })),
      },
    };
    return job === "token" ? tokenTicketFrom(src) : kitchenTicketFrom(src);
  }

  /**
   * What came of it.
   *
   * A failure keeps its error so the station screen can show it beside a
   * Reprint button, and `printed_at` is stamped only on success — a
   * timestamp on a failure would have the owner's list claim a ticket
   * printed when no paper came out.
   */
  async report(
    userId: string,
    businessId: string,
    stationId: string,
    receiptId: string,
    body: { status: "printed" | "failed"; error?: string },
  ) {
    await this.stations.resolve(userId, businessId, stationId, { touch: true });

    const receipt = await this.prisma.db.printReceipt.findFirst({
      where: { id: BigInt(receiptId), stationId, businessId },
    });
    if (!receipt) throw new NotFoundException("Receipt not found");

    await this.prisma.db.printReceipt.update({
      where: { id: receipt.id },
      data: {
        status: body.status,
        error: body.error ?? null,
        printedAt: body.status === "printed" ? new Date() : null,
      },
    });
  }
}
