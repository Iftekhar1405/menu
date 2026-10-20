import { encodeTicket, type PaperWidth, type PrintJob, type Ticket } from "@menu/shared";
import type { PrinterTransport } from "./transport";

export type { PrinterTransport } from "./transport";

export interface PendingJob {
  eventId: string;
  job: PrintJob;
  kind: string;
  at: string;
  orderId: string;
  tableLabel: string;
  token: number;
}

/** A job whose most recent attempt failed, with what went wrong (I1/C2). */
export interface FailedJob extends PendingJob {
  error: string | null;
  attempt: number;
}

export interface Claimed {
  receiptId: string;
  paperWidth: PaperWidth;
  ticket: Ticket;
}

export interface PendingResponse {
  pending: PendingJob[];
  missed: PendingJob[];
  /** Currently `failed`, with its error — see the station page's Failed list. */
  failed: FailedJob[];
  topic: string | null;
}

export interface StationApi {
  pending(): Promise<PendingResponse>;
  /** Resolves to "taken" when another tab won the race — a 409, not an error. */
  claim(eventId: string, job: PrintJob, reprint: boolean): Promise<Claimed | "taken">;
  report(receiptId: string, status: "printed" | "failed", error?: string): Promise<void>;
}

export interface StationOutputRef {
  job: PrintJob;
  deviceKey: string;
}

export interface DrainResult {
  printed: number;
  skipped: number;
  failed: number;
  /** Jobs with waiting work whose printer is not currently connected. */
  disconnected: PrintJob[];
  /**
   * A claim that threw something other than "taken" — a bill job offered to
   * a non-owner principal, a revoked station, a dropped connection. Counted
   * rather than left to escape the loop, so one such job cannot wedge every
   * job still waiting behind it in this pass (C1).
   */
  claimErrors: number;
  /** The most recent claim error's message, if any occurred this pass. */
  claimError?: string;
  /**
   * Carried straight from the one `pending()` call this pass already made
   * (I2): the page used to call `pending()` a second time afterwards just to
   * read these three fields, which sequential-scanned `order_events` twice
   * every ten seconds for nothing `drain()` did not already know.
   */
  missed: PendingJob[];
  failedReceipts: FailedJob[];
  topic: string | null;
}

/**
 * How many characters of a device error the server will accept.
 *
 * Mirrors `receiptResultSchema`'s `error` cap in packages/shared/src/schemas.ts
 * — kept as a local constant rather than imported because the two must agree
 * on a number, not share a module the station bundle has no other reason to
 * pull in. A WebUSB error can run to a kilobyte of vendor text; untruncated,
 * the 400 from exceeding the cap would make `report()` throw, and the
 * receipt would stay `claimed` forever — the same ghost `I1` already names.
 */
const MAX_ERROR_LENGTH = 500;

/** Truncates a device error to what the server will accept, verbatim otherwise. */
export function truncateError(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? message.slice(0, MAX_ERROR_LENGTH) : message;
}

/**
 * One pass: print everything waiting that this machine can print.
 *
 * Two orderings here are load-bearing.
 *
 * The printer is checked BEFORE the claim. Claiming first would consume
 * the ticket and then fail to write it, and nothing would offer it again —
 * the slip would simply never exist. Leaving it unclaimed is what makes
 * "Kitchen printer not connected — 2 tickets waiting" a true statement
 * that resolves itself when the cable goes back in.
 *
 * And the report comes after the write, never instead of it. A receipt
 * marked printed is a promise that paper came out.
 *
 * Missed jobs are never touched: that is the whole point of the window.
 */
export async function drain(
  api: StationApi,
  transport: PrinterTransport,
  outputs: StationOutputRef[],
): Promise<DrainResult> {
  const { pending, missed, failed: failedReceipts, topic } = await api.pending();
  const result: DrainResult = {
    printed: 0,
    skipped: 0,
    failed: 0,
    disconnected: [],
    claimErrors: 0,
    missed,
    failedReceipts,
    topic,
  };
  if (pending.length === 0) return result;

  const connected = new Set(await transport.granted());
  const byJob = new Map(outputs.map((o) => [o.job, o.deviceKey]));

  for (const item of pending) {
    const deviceKey = byJob.get(item.job);
    if (!deviceKey) continue;

    if (!connected.has(deviceKey)) {
      if (!result.disconnected.includes(item.job)) result.disconnected.push(item.job);
      continue;
    }

    let claimed: Claimed | "taken";
    try {
      claimed = await api.claim(item.eventId, item.job, false);
    } catch (e) {
      // C1: a claim can be refused for reasons that are not a race — a bill
      // job offered to a kitchen principal, a station revoked mid-pass. An
      // unguarded await here let that throw escape the loop and abandon
      // every job still waiting behind it. Counted and carried instead, so
      // the pass finishes and the page is not silent about it.
      result.claimErrors++;
      result.claimError = e instanceof Error ? e.message : String(e);
      continue;
    }
    if (claimed === "taken") {
      result.skipped++;
      continue;
    }

    try {
      await transport.write(deviceKey, encodeTicket(claimed.ticket, claimed.paperWidth));
      await api.report(claimed.receiptId, "printed", undefined);
      result.printed++;
    } catch (e) {
      // One jammed printer must not stop the other roll on this machine.
      await api.report(claimed.receiptId, "failed", truncateError((e as Error).message));
      result.failed++;
    }
  }

  return result;
}

export type ReprintOutcome =
  | { outcome: "taken" }
  | { outcome: "printed" }
  | { outcome: "failed"; error: string }
  | { outcome: "no-output" }
  /** A claim this principal was never going to be allowed to make, or any
   * other throw that is not "someone else took it" (M1). */
  | { outcome: "error"; error: string };

/**
 * The manual Print/Reprint button on the station page's Missed and Failed
 * lists — a single job, forced to the next attempt regardless of what
 * `drain()`'s own pass would have done with it this round.
 *
 * Pulled out of the page component because this file is where station logic
 * is unit tested; `station/page.tsx` has no test harness of its own (no
 * jsdom, no `.spec.tsx` in this project's vitest config) for exactly that
 * reason. M1 was the Missed list's `onClick` calling `client.claim` outside
 * its own try/catch — this function's outer try/catch is that fix, made
 * testable.
 */
export async function reprintJob(
  api: StationApi,
  transport: PrinterTransport,
  outputs: StationOutputRef[],
  job: PendingJob,
): Promise<ReprintOutcome> {
  try {
    const claimed = await api.claim(job.eventId, job.job, true);
    if (claimed === "taken") return { outcome: "taken" };

    const deviceKey = outputs.find((o) => o.job === job.job)?.deviceKey;
    if (!deviceKey) return { outcome: "no-output" };

    try {
      await transport.write(deviceKey, encodeTicket(claimed.ticket, claimed.paperWidth));
      await api.report(claimed.receiptId, "printed", undefined);
      return { outcome: "printed" };
    } catch (e) {
      const error = truncateError(e instanceof Error ? e.message : String(e));
      await api.report(claimed.receiptId, "failed", error);
      return { outcome: "failed", error };
    }
  } catch (e) {
    // M1: `client.claim` used to sit outside this function entirely, in the
    // page's onClick, with no try/catch around it at all — a bill job this
    // principal may not claim, or a station revoked since the page loaded,
    // was an unhandled rejection with nothing shown on the page.
    return { outcome: "error", error: e instanceof Error ? e.message : "Could not reprint this ticket" };
  }
}
