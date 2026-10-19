import { describe, expect, it, vi } from "vitest";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { ReceiptsService } from "./receipts.service";

/**
 * What `$queryRaw` surfaces when the claim's unique index rejects the insert.
 *
 * Not a Prisma P2002: a raw query failure arrives as the Postgres error text,
 * so the service matches on the constraint name. A fake that threw P2002
 * would test a code path production never reaches.
 */
class UniqueViolation extends Error {
  constructor() {
    super(
      'ERROR: duplicate key value violates unique constraint "print_receipts_claim_key"',
    );
  }
}

function makeSvc(opts: { role?: "owner" | "kitchen"; insert?: () => unknown } = {}) {
  const create = vi.fn(opts.insert ?? (async () => ({ id: BigInt(9), attempt: 1 })));
  const queryRaw = vi.fn(async (..._args: unknown[]) => [{ receipt: await create() }]);
  const prisma = {
    db: {
      printReceipt: { create, findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
      orderEvent: {
        findFirst: vi.fn().mockResolvedValue({
          id: BigInt(1),
          kind: "round.accepted",
          orderId: "o1",
          roundId: "r1",
          businessId: "b1",
        }),
      },
      orderRound: {
        findFirst: vi.fn().mockResolvedValue({
          seq: 2, kotNumber: 38, placedAt: new Date("2026-10-04T15:36:00.000Z"),
          items: [{ quantity: 2, nameSnapshot: "Irani Chai", variantSnapshot: null }],
          order: { dailyNumber: 14, note: null, isRunning: false, table: { label: "7" } },
        }),
      },
      $queryRaw: queryRaw,
    },
  };
  const stations = {
    resolve: vi.fn().mockResolvedValue({
      id: "s1", businessId: "b1", revokedAt: null,
      business: { name: "Taste of Hyderabad" },
      outputs: [
        { job: "token", paperWidth: 58 },
        { job: "kitchen", paperWidth: 80 },
        { job: "bill", paperWidth: 80 },
      ],
    }),
    roleFor: vi.fn().mockResolvedValue(opts.role ?? "owner"),
  };
  const billing = { generate: vi.fn() };
  return {
    svc: new ReceiptsService(prisma as never, stations as never, billing as never),
    create,
    billing,
    prisma,
    queryRaw,
  };
}

describe("ReceiptsService.claim", () => {
  it("hands back the ticket with the receipt, in one round trip", async () => {
    const { svc } = makeSvc();
    const out = await svc.claim("u1", "b1", "s1", { eventId: "1", job: "kitchen" });
    expect(out).toMatchObject({ receiptId: "9", attempt: 1, paperWidth: 80 });
    expect(out.ticket).toMatchObject({ kind: "kitchen", token: 14, kotNumber: 38 });
  });

  it("uses the paper width of the output that will print it", async () => {
    // One machine can hold a 58mm token roll and an 80mm kitchen roll.
    // Width is a property of the output, never of the station.
    const { svc } = makeSvc();
    const out = await svc.claim("u1", "b1", "s1", { eventId: "1", job: "token" });
    expect(out.paperWidth).toBe(58);
  });

  it("turns a lost race into 409, not a 500", async () => {
    // Review Focus 2. Two tabs on one machine both claim; the loser must
    // get an answer it can treat as "someone else took it" and move on.
    const { svc } = makeSvc({
      insert: () => {
        throw new UniqueViolation();
      },
    });
    await expect(
      svc.claim("u1", "b1", "s1", { eventId: "1", job: "token" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuses a bill claim from a kitchen principal", async () => {
    // Review Focus 1. The station could only have a bill output if an owner
    // attached it, but the claim is a second door into the same prices and
    // it gets the same lock.
    //
    // The event must be one that actually produces a bill ("completed"),
    // not the default "round.accepted" — otherwise the jobsForEvent check
    // a few lines further down rejects the request first, the role check
    // is never reached, and this test passes whether or not that check
    // exists. (Caught by deleting the role check and watching this test
    // stay green with the default fixture.)
    const { svc, prisma } = makeSvc({ role: "kitchen" });
    (
      prisma.db.orderEvent.findFirst as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      id: BigInt(1),
      kind: "completed",
      orderId: "o1",
      roundId: null,
      businessId: "b1",
    });
    await expect(
      svc.claim("u1", "b1", "s1", { eventId: "1", job: "bill" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a job the event does not produce", async () => {
    // Nothing should be able to ask for a bill off an accepted round. The
    // mapping is the authority, and a client is not.
    const { svc } = makeSvc();
    await expect(
      svc.claim("u1", "b1", "s1", { eventId: "1", job: "bill" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a job this station has no printer for", async () => {
    const { svc } = makeSvc();
    (svc as never as { stations: { resolve: ReturnType<typeof vi.fn> } }).stations.resolve =
      vi.fn().mockResolvedValue({
        id: "s1", businessId: "b1", revokedAt: null,
        business: { name: "X" }, outputs: [{ job: "kitchen", paperWidth: 80 }],
      });
    await expect(
      svc.claim("u1", "b1", "s1", { eventId: "1", job: "token" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("passes the claim's own ids to claim_print_receipt, not the fixture's", async () => {
    // Task 8's review finding, carried forward: asserting the SQL names the
    // right function proves nothing if the arguments could be swapped. Ids
    // distinct from every other fixture default ("biz-9", "stn-9", 1234n)
    // make a swapped pair of arguments actually detectable.
    const { svc, prisma, queryRaw } = makeSvc();
    (
      prisma.db.orderEvent.findFirst as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      id: BigInt(1234),
      kind: "round.accepted",
      orderId: "o1",
      roundId: "r1",
      businessId: "biz-9",
    });
    (
      (svc as never as { stations: { resolve: ReturnType<typeof vi.fn> } }).stations.resolve
    ) = vi.fn().mockResolvedValue({
      id: "stn-9", businessId: "biz-9",
      business: { name: "Taste of Hyderabad" },
      outputs: [{ job: "token", paperWidth: 58 }],
    });

    await svc.claim("u1", "biz-9", "stn-9", { eventId: "1234", job: "token" });

    const call = queryRaw.mock.calls[0]!;
    // call[0] is the tagged template's literal strings; the interpolated
    // values follow it in order: business id, station id, event id, job,
    // attempt.
    expect(call[1]).toBe("biz-9");
    expect(call[2]).toBe("stn-9");
    expect(call[3]).toBe(BigInt(1234));
    expect(call[4]).toBe("token");
    expect(call[5]).toBe(1);
  });
});

describe("ReceiptsService.report", () => {
  it("records a failure with its error, so the screen can offer a reprint", async () => {
    const { svc } = makeSvc();
    const prisma = (svc as never as { prisma: { db: { printReceipt: { update: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> } } } }).prisma;
    prisma.db.printReceipt.findFirst.mockResolvedValue({ id: BigInt(9), stationId: "s1" });

    await svc.report("u1", "b1", "s1", "9", { status: "failed", error: "device unavailable" });
    expect(prisma.db.printReceipt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          error: "device unavailable",
          // A failure must not also stamp printed_at — that field is what
          // the owner's list reads as "paper came out", and a mutation that
          // stamped it unconditionally would otherwise pass this suite,
          // since only the success test below checked the timestamp at all.
          printedAt: null,
        }),
      }),
    );
  });

  it("stamps printed_at only on success", async () => {
    // "Printed at" has to mean paper came out. A timestamp on a failure
    // would make the owner's list say a ticket printed when it did not.
    const { svc } = makeSvc();
    const prisma = (svc as never as { prisma: { db: { printReceipt: { update: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> } } } }).prisma;
    prisma.db.printReceipt.findFirst.mockResolvedValue({ id: BigInt(9), stationId: "s1" });

    await svc.report("u1", "b1", "s1", "9", { status: "printed" });
    const data = prisma.db.printReceipt.update.mock.calls[0]![0].data as { printedAt: Date | null };
    expect(data.printedAt).toBeInstanceOf(Date);
  });
});
