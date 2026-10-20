import { describe, expect, it, vi } from "vitest";
import { drain, reprintJob, type PrinterTransport, type StationApi } from "./loop";

const job = (eventId: string, j: "token" | "kitchen" | "bill") => ({
  eventId, job: j, kind: "round.accepted", at: "2026-10-04T15:36:00.000Z",
  orderId: "o1", tableLabel: "7", token: 14,
});

const ticket = { kind: "token", businessName: "X", token: 14, seq: 1, tableLabel: "7", at: "2026-10-04T15:36:00.000Z" } as const;

function fakes(opts: {
  pending?: ReturnType<typeof job>[];
  granted?: string[];
  claim?: StationApi["claim"];
  write?: PrinterTransport["write"];
} = {}) {
  const api: StationApi = {
    pending: vi.fn().mockResolvedValue({
      pending: opts.pending ?? [job("1", "token")],
      missed: [],
      failed: [],
      topic: "business:abc",
    }),
    claim: opts.claim ?? vi.fn().mockResolvedValue({ receiptId: "9", paperWidth: 58, ticket }),
    report: vi.fn().mockResolvedValue(undefined),
  };
  const transport: PrinterTransport = {
    granted: vi.fn().mockResolvedValue(opts.granted ?? ["dev-token"]),
    write: opts.write ?? vi.fn().mockResolvedValue(undefined),
  };
  return { api, transport, outputs: [{ job: "token" as const, deviceKey: "dev-token" }] };
}

describe("drain", () => {
  it("claims, writes and reports each waiting job, in that order", async () => {
    const { api, transport, outputs } = fakes();
    const out = await drain(api, transport, outputs);

    expect(api.claim).toHaveBeenCalledWith("1", "token", false);
    expect(transport.write).toHaveBeenCalledOnce();
    expect(api.report).toHaveBeenCalledOnce();
    expect(api.report).toHaveBeenCalledWith("9", "printed", undefined);
    // The report is a promise paper came out: it must follow the write,
    // never precede or replace it. A single toHaveBeenCalledWith cannot
    // tell "called after" from "called instead of, earlier" — comparing
    // invocation order can.
    const writeOrder = (transport.write as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const reportOrder = (api.report as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(writeOrder).toBeLessThan(reportOrder);
    expect(out).toMatchObject({ printed: 1, failed: 0, skipped: 0 });
  });

  it("treats a lost claim as someone else's ticket, not an error", async () => {
    // Review Focus 2, the other half. The index stops the second slip; this
    // stops the second tab showing the staff a red error about it.
    const { api, transport, outputs } = fakes({ claim: vi.fn().mockResolvedValue("taken") });
    const out = await drain(api, transport, outputs);

    expect(transport.write).not.toHaveBeenCalled();
    expect(api.report).not.toHaveBeenCalled();
    expect(out).toMatchObject({ printed: 0, skipped: 1, failed: 0 });
  });

  it("does not claim a job whose printer is not connected", async () => {
    // Claiming first would consume the ticket and then fail to print it,
    // and nothing would ever offer it again. The job stays unclaimed until
    // the printer is back, which is what makes "2 tickets waiting" true.
    const { api, transport, outputs } = fakes({ granted: [] });
    const out = await drain(api, transport, outputs);

    expect(api.claim).not.toHaveBeenCalled();
    expect(out.disconnected).toEqual(["token"]);
    expect(out.printed).toBe(0);
  });

  it("reports a write that failed, with the error, and never reports it printed", async () => {
    // Half-printed paper is physical: the screen needs to offer a reprint,
    // and it can only do that if the receipt says what went wrong — and
    // only that, not also a "printed" report for the same ticket.
    const { api, transport, outputs } = fakes({
      write: vi.fn().mockRejectedValue(new Error("device unavailable")),
    });
    const out = await drain(api, transport, outputs);

    expect(api.report).toHaveBeenCalledOnce();
    expect(api.report).toHaveBeenCalledWith("9", "failed", "device unavailable");
    expect(out).toMatchObject({ printed: 0, failed: 1 });
  });

  it("truncates a device error before reporting it, so a long one cannot stick the receipt at claimed", async () => {
    // I5: receiptResultSchema caps `error` at 500 characters. A longer
    // WebUSB message makes the report() POST itself fail with a 400 — which
    // throws, so the receipt never reaches "failed" and sits at "claimed"
    // forever, the same ghost I1 names for a different reason.
    const long = "x".repeat(600);
    const { api, transport, outputs } = fakes({
      write: vi.fn().mockRejectedValue(new Error(long)),
    });
    await drain(api, transport, outputs);

    const reported = (api.report as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string;
    expect(reported.length).toBeLessThanOrEqual(500);
  });

  it("keeps going after one job fails", async () => {
    // One jammed printer must not stop the other roll on the same machine.
    const { api, transport } = fakes({ pending: [job("1", "token"), job("2", "kitchen")] });
    (transport.write as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("jam"))
      .mockResolvedValueOnce(undefined);

    const out = await drain(api, transport, [
      { job: "token", deviceKey: "dev-token" },
      { job: "kitchen", deviceKey: "dev-token" },
    ]);
    expect(out).toMatchObject({ printed: 1, failed: 1 });
  });

  it("counts a claim that throws something other than taken, and keeps going", async () => {
    // C1: the counter holds token + bill, and a kitchen-role principal is
    // logged in on that tab. pending() still offers bill (until the server
    // fix below excludes it), claim() refuses it with a 403, and before this
    // fix the unguarded await let that throw escape the for loop — every
    // job after the bill job, including the token slip, was abandoned for
    // the rest of this pass and every pass after it until the bill job left
    // the 30-minute window.
    const claim = vi
      .fn()
      .mockRejectedValueOnce(new Error("Only the owner can print a bill"))
      .mockResolvedValueOnce({ receiptId: "9", paperWidth: 58, ticket });
    const api: StationApi = {
      pending: vi.fn().mockResolvedValue({
        pending: [job("1", "bill"), job("2", "token")],
        missed: [],
        failed: [],
        topic: null,
      }),
      claim,
      report: vi.fn().mockResolvedValue(undefined),
    };
    const transport: PrinterTransport = {
      granted: vi.fn().mockResolvedValue(["dev-token"]),
      write: vi.fn().mockResolvedValue(undefined),
    };

    const out = await drain(api, transport, [
      { job: "bill", deviceKey: "dev-token" },
      { job: "token", deviceKey: "dev-token" },
    ]);

    expect(out.claimErrors).toBe(1);
    expect(out.claimError).toBe("Only the owner can print a bill");
    // The job behind the failed claim still got printed — the pass kept
    // going instead of being abandoned.
    expect(out.printed).toBe(1);
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it("carries missed, failed and topic straight from the one pending() call", async () => {
    // I2: the page used to call pending() a second time after drain() just
    // to read these three fields. drain() already has them from the call it
    // made for the print pass itself, so it hands them back instead.
    const missed = [job("9", "token")];
    const failed = [{ ...job("8", "kitchen"), error: "device unavailable", attempt: 1 }];
    const { api, transport, outputs } = fakes({ pending: [] });
    (api.pending as ReturnType<typeof vi.fn>).mockResolvedValue({
      pending: [],
      missed,
      failed,
      topic: "business:abc",
    });

    const out = await drain(api, transport, outputs);
    expect(out.missed).toBe(missed);
    expect(out.failedReceipts).toBe(failed);
    expect(out.topic).toBe("business:abc");
  });

  it("never prints a missed job on its own", async () => {
    // The whole point of the window: what is old waits for a human.
    const api: StationApi = {
      pending: vi.fn().mockResolvedValue({
        pending: [],
        missed: [job("9", "token")],
        failed: [],
        topic: null,
      }),
      claim: vi.fn(),
      report: vi.fn(),
    };
    const { transport, outputs } = fakes();
    await drain(api, transport, outputs);
    expect(api.claim).not.toHaveBeenCalled();
  });
});

describe("reprintJob", () => {
  it("claims as a reprint, writes, and reports printed", async () => {
    const { api, transport, outputs } = fakes();
    const out = await reprintJob(api, transport, outputs, job("1", "token"));
    expect(api.claim).toHaveBeenCalledWith("1", "token", true);
    expect(out).toEqual({ outcome: "printed" });
  });

  it("reports a claim that resolves to taken, without touching the printer", async () => {
    const { api, transport, outputs } = fakes({ claim: vi.fn().mockResolvedValue("taken") });
    const out = await reprintJob(api, transport, outputs, job("1", "token"));
    expect(transport.write).not.toHaveBeenCalled();
    expect(out).toEqual({ outcome: "taken" });
  });

  it("returns an error outcome when the claim throws, instead of an unhandled rejection (M1)", async () => {
    // Before this fix, the Missed list's onClick called client.claim with no
    // try/catch around it at all: a bill job this principal may not claim,
    // or a station revoked since the page loaded, was an unhandled
    // rejection with nothing shown on the page.
    const { transport, outputs } = fakes();
    const api: StationApi = {
      pending: vi.fn(),
      claim: vi.fn().mockRejectedValue(new Error("Only the owner can print a bill")),
      report: vi.fn(),
    };
    const out = await reprintJob(api, transport, outputs, job("1", "bill"));
    expect(out).toEqual({ outcome: "error", error: "Only the owner can print a bill" });
  });

  it("truncates a long write error before reporting it (I5, same shape here)", async () => {
    const long = "x".repeat(600);
    const { api, transport, outputs } = fakes({
      write: vi.fn().mockRejectedValue(new Error(long)),
    });
    const out = await reprintJob(api, transport, outputs, job("1", "token"));
    expect(out.outcome).toBe("failed");
    expect(out).toMatchObject({ outcome: "failed" });
    if (out.outcome === "failed") expect(out.error.length).toBeLessThanOrEqual(500);
    const reported = (api.report as ReturnType<typeof vi.fn>).mock.calls[0]![2] as string;
    expect(reported.length).toBeLessThanOrEqual(500);
  });
});
