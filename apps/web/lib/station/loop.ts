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

export interface Claimed {
  receiptId: string;
  paperWidth: PaperWidth;
  ticket: Ticket;
}

export interface StationApi {
  pending(): Promise<{ pending: PendingJob[]; missed: PendingJob[]; topic: string | null }>;
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
  const { pending } = await api.pending();
  const result: DrainResult = { printed: 0, skipped: 0, failed: 0, disconnected: [] };
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

    const claimed = await api.claim(item.eventId, item.job, false);
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
      await api.report(claimed.receiptId, "failed", (e as Error).message);
      result.failed++;
    }
  }

  return result;
}
