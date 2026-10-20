import { describe, expect, it, vi } from "vitest";
import { drain, type PrinterTransport, type StationApi } from "./loop";

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

  it("never prints a missed job on its own", async () => {
    // The whole point of the window: what is old waits for a human.
    const api: StationApi = {
      pending: vi.fn().mockResolvedValue({ pending: [], missed: [job("9", "token")], topic: null }),
      claim: vi.fn(),
      report: vi.fn(),
    };
    const { transport, outputs } = fakes();
    await drain(api, transport, outputs);
    expect(api.claim).not.toHaveBeenCalled();
  });
});
