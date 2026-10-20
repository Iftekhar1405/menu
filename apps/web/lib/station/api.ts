import { api, ApiError } from "@/lib/api-client";
import type { PrintJob } from "@menu/shared";
import type { Claimed, PendingResponse, StationApi } from "./loop";

/**
 * The loop's api, over HTTP.
 *
 * The one judgement here is which failures are the loop's business. A 409
 * means another tab won the claim, which is a normal outcome and not an
 * error — the loop is told "taken" and moves on. Everything else,
 * including the 410 that means this machine has been revoked, is thrown
 * so the page can act on it.
 */
export function stationApi(businessId: string, stationId: string): StationApi {
  const base = `/businesses/${businessId}/stations/${stationId}`;

  return {
    pending: () => api.get<PendingResponse>(`${base}/pending`),

    async claim(eventId: string, job: PrintJob, reprint: boolean) {
      try {
        return await api.post<Claimed>(`${base}/receipts`, { eventId, job, reprint });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) return "taken" as const;
        throw e;
      }
    },

    report: (receiptId, status, error) =>
      api.post(`${base}/receipts/${receiptId}/result`, { status, error }).then(() => undefined),
  };
}
