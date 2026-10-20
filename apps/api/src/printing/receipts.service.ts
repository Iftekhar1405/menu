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

/**
 * How many events one `pending()` call will look at.
 *
 * `order_events` is append-only and multi-tenant; without a bound this is an
 * unbounded scan of one business's slice of it every ten seconds, per
 * station (I2). Ordered newest-first before the cap is applied and reversed
 * afterwards, so a business busy enough to exceed this in `MISSED_HOURS`
 * loses its oldest missed tickets first, never the ones still inside the
 * 30-minute pending window.
 */
const MAX_EVENTS = 2000;

/**
 * How long a claim may sit unresolved before it is treated as abandoned.
 *
 * A receipt reaches `claimed` the instant the insert succeeds and normally
 * moves to `printed` or `failed` within the few seconds a write takes. One
 * that outlives this window — the tab closed mid-write, the network
 * dropped, `ticketFor` threw after the insert had already committed — is
 * not "about to resolve itself"; nothing is coming. `pending` (I1) and
 * `claim`'s retry-on-collision (C2) both treat it exactly like a failed
 * receipt: fair game to be offered again and reclaimed as the next attempt.
 * Minutes, not seconds, so an ordinary slow printer write is never mistaken
 * for a dead tab.
 */
const STALE_CLAIM_MINUTES = 5;

/**
 * A receipt that must no longer block a re-offer (`pending`) or an insert
 * (`claim`'s retry): it either failed outright, or it has sat `claimed` long
 * enough that whatever was going to report it is not coming back.
 */
function isAbandoned(row: { status: string; claimedAt: Date }, now: Date): boolean {
  if (row.status === "failed") return true;
  if (row.status === "claimed") {
    return now.getTime() - row.claimedAt.getTime() >= STALE_CLAIM_MINUTES * 60_000;
  }
  return false;
}

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

/**
 * A job whose most recent attempt failed, carried with its error so the
 * station page can show what went wrong (C2) rather than the failure being
 * visible for ten seconds and then disappearing.
 */
export interface FailedJob extends PendingJob {
  error: string | null;
  attempt: number;
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
  ): Promise<{ pending: PendingJob[]; missed: PendingJob[]; failed: FailedJob[]; topic: string | null }> {
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
    if (jobs.size === 0) return { pending: [], missed: [], failed: [], topic };

    // C1: a station can hold a bill output while the principal asking right
    // now is not the owner — the counter's token+bill machine, logged in as
    // kitchen. `claim()` already refuses that with a 403, but refusing it
    // only there means pending() still offers the job, and an un-caught
    // throw from a claim this principal was never going to be allowed to
    // make wedges every job behind it in the station's print pass. Checked
    // only when the station actually holds a bill output, so a kitchen-only
    // machine never pays for a role lookup it has no reason to need.
    if (jobs.has("bill")) {
      const role = await this.stations.roleFor(userId, businessId);
      if (role !== "owner") jobs.delete("bill");
    }

    const since = new Date(now.getTime() - MISSED_HOURS * 3_600_000);
    // Newest first so MAX_EVENTS caps away the oldest tail, then restored to
    // chronological order — the loop below, and the page, expect that.
    const events = await this.prisma.db.orderEvent.findMany({
      where: { businessId, at: { gte: since } },
      orderBy: { at: "desc" },
      take: MAX_EVENTS,
      include: { order: { select: { dailyNumber: true, table: { select: { label: true } } } } },
    });
    events.reverse();

    // Every receipt this station has for an event in the window, newest
    // attempt first per (event, job). Unfiltered by status: telling apart
    // "printed", "an abandoned claim" (I1) and "failed, offer it again" (C2)
    // all need to see every attempt, not just whichever survives a WHERE
    // clause tuned for one of those three.
    const receipts = await this.prisma.db.printReceipt.findMany({
      where: { stationId, event: { at: { gte: since } } },
      orderBy: { attempt: "desc" },
      select: { eventId: true, job: true, status: true, claimedAt: true, error: true, attempt: true },
    });

    type ReceiptRow = (typeof receipts)[number];
    const latest = new Map<string, ReceiptRow>();
    for (const r of receipts) {
      const key = `${r.eventId}:${r.job}`;
      // Rows arrive highest-attempt first, so the first one seen per key is
      // the attempt that decides the job's current state.
      if (!latest.has(key)) latest.set(key, r);
    }

    const done = new Set<string>();
    const failedByKey = new Map<string, ReceiptRow>();
    for (const [key, r] of latest) {
      if (isAbandoned(r, now)) {
        if (r.status === "failed") failedByKey.set(key, r);
        continue; // abandoned claim: re-offered below, no list of its own
      }
      done.add(key);
    }

    const cutoff = now.getTime() - WINDOW_MINUTES * 60_000;
    const pending: PendingJob[] = [];
    const missed: PendingJob[] = [];
    const failed: FailedJob[] = [];

    for (const e of events) {
      for (const job of jobsForEvent(e.kind)) {
        if (!jobs.has(job)) continue;
        const key = `${e.id}:${job}`;

        const row: PendingJob = {
          eventId: String(e.id),
          job,
          kind: e.kind,
          at: e.at.toISOString(),
          orderId: e.orderId,
          tableLabel: e.order.table.label,
          token: e.order.dailyNumber,
        };

        const failedRow = failedByKey.get(key);
        if (failedRow) failed.push({ ...row, error: failedRow.error, attempt: failedRow.attempt });

        if (done.has(key)) continue;
        (e.at.getTime() >= cutoff ? pending : missed).push(row);
      }
    }

    return { pending, missed, failed, topic };
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
    now: Date = new Date(),
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

    const attempt = await this.resolveAttempt(stationId, event.id, body.job, body.reprint, now);
    const receipt = await this.insertClaim(businessId, stationId, event.id, body.job, attempt);

    const ticket = await this.ticketFor(userId, businessId, station, event, body.job);
    return {
      receiptId: String(receipt.id),
      attempt: receipt.attempt,
      paperWidth: output.paperWidth,
      ticket,
    };
  }

  /**
   * Which attempt number this claim should use — decided before the insert
   * that commits to it, never after.
   *
   * Every authenticated request runs inside one transaction, opened by
   * `TenantInterceptor` and held for the whole request — see
   * `two-stations.spec.ts`'s "final review fixes" suite, which is what
   * caught this: a first draft of C2/I1 caught the unique violation and then
   * queried `printReceipt` again to decide whether to retry, and against a
   * mocked Prisma client that looked fine. Against real Postgres it is not —
   * a failed statement leaves the transaction in `25P02`, "current
   * transaction is aborted", and refuses every query after it until the
   * whole request rolls back. There is no recovering from a collision once
   * it happens; the only way to survive one is to not cause it.
   *
   * So the default attempt (1, unless this is an explicit reprint) is
   * checked against what is already there. If that row failed, or if it has
   * sat `claimed` past `STALE_CLAIM_MINUTES` with nobody reporting on it
   * (I1), it is abandoned — `isAbandoned` is the one predicate this and
   * `pending()` both use, so the two cannot disagree about which row still
   * blocks a claim — and the next attempt is used instead, pre-emptively.
   * `drain()` always asks for attempt 1 with `reprint: false`; this is what
   * lets a receipt that failed at attempt 1 print again ten seconds later
   * instead of colliding with its own corpse forever (C2).
   */
  private async resolveAttempt(
    stationId: string,
    eventId: bigint,
    job: PrintJob,
    reprint: boolean | undefined,
    now: Date,
  ): Promise<number> {
    if (reprint) return this.nextAttempt(stationId, eventId, job);

    const existing = await this.prisma.db.printReceipt.findFirst({
      where: { stationId, eventId, job, attempt: 1 },
      select: { status: true, claimedAt: true },
    });
    if (existing && isAbandoned(existing, now)) {
      return this.nextAttempt(stationId, eventId, job);
    }
    return 1;
  }

  /**
   * THE INSERT IS THE CLAIM. Two tabs on one machine both arrive here; the
   * unique index on (station, event, job, attempt) lets one through and the
   * other gets a 409 it treats as "someone else took it". Checking first and
   * inserting second would lose the race it is trying to win.
   *
   * By the time this runs, `resolveAttempt` has already steered away from
   * any attempt number a dead row occupies, so a collision reaching here is
   * a genuine race — two tabs resolving the same attempt at once — and must
   * come back as 409 with no further query: see `resolveAttempt`'s comment
   * for why a query after a failed one is not available to recover with.
   */
  private async insertClaim(
    businessId: string,
    stationId: string,
    eventId: bigint,
    job: PrintJob,
    attempt: number,
  ): Promise<{ id: bigint; attempt: number }> {
    try {
      // Through claim_print_receipt, not printReceipt.create: there is no
      // kitchen INSERT policy on this table, by the schema-wide invariant
      // asserted in kitchen-policies.spec.ts.
      //
      // `SELECT id, attempt FROM claim_print_receipt(...)`, not
      // `SELECT claim_print_receipt(...) AS receipt`: the latter returns the
      // function's whole `print_receipts` composite as a single column, and
      // Prisma's query engine cannot deserialize a composite column — every
      // successful claim threw "Failed to deserialize column of type
      // 'print_receipts'". No existing test caught it: claim.spec.ts mocks
      // `$queryRaw`, and the real-database suite only ever drove a conflict,
      // never a successful insert, through this path. Calling the function
      // in the FROM clause instead exposes its row as ordinary scalar
      // columns, which deserialize the same way any other query's do.
      const rows = await this.prisma.db.$queryRaw<
        { id: bigint; attempt: number }[]
      >`SELECT id, attempt FROM claim_print_receipt(
          ${businessId}::uuid, ${stationId}::uuid, ${eventId}::bigint,
          ${job}::"PrintJob", ${attempt}::int
        )`;
      return rows[0]!;
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
