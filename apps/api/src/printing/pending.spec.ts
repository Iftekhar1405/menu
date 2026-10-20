import { beforeEach, describe, expect, it, vi } from "vitest";
import { businessChannel } from "../notifications/channel-name";
import { ReceiptsService } from "./receipts.service";

/*
 * `loadEnv()` memoises into a module-level `cached`, so setting process.env
 * inside a test is too late to change what the service sees. The module is
 * mocked instead — which is also what lets the pair of topic tests below
 * tell `usesRealtime(env)` apart from a truthiness test on the secret.
 *
 * Mocking "../config/env" replaces the whole module for this file, so the
 * factory below must cover every export receipts.service.ts imports from it
 * (currently just `loadEnv` and `usesRealtime`) — anything else pulled in
 * via that path at load time would come back `undefined`.
 */
let realtimeOn = true;
vi.mock("../config/env", () => ({
  loadEnv: () => ({ REALTIME_CHANNEL_SECRET: "test-secret" }),
  usesRealtime: () => realtimeOn,
}));

beforeEach(() => {
  realtimeOn = true;
});

/**
 * The window and the mapping, against a fake Prisma. These are decisions,
 * and the thing that makes them worth a test is that both failure modes are
 * silent: too wide a window buries the shop in paper at closing time, and a
 * mapping that drops a job means a ticket that simply never prints.
 */
const NOW = new Date("2026-10-04T15:30:00.000Z");

function makeSvc(
  events: unknown[],
  receipts: unknown[] = [],
  outputs = ["token", "kitchen"],
  role: "owner" | "kitchen" = "owner",
) {
  const prisma = {
    db: {
      orderEvent: { findMany: vi.fn().mockResolvedValue(events) },
      printReceipt: { findMany: vi.fn().mockResolvedValue(receipts) },
    },
  };
  const stations = {
    resolve: vi.fn().mockResolvedValue({
      id: "s1",
      businessId: "b1",
      revokedAt: null,
      outputs: outputs.map((job) => ({ job })),
    }),
    roleFor: vi.fn().mockResolvedValue(role),
  };
  const billing = { generate: vi.fn() };
  return {
    svc: new ReceiptsService(prisma as never, stations as never, billing as never),
    prisma,
    stations,
  };
}

const event = (id: string, kind: string, minutesAgo: number) => ({
  id: BigInt(id),
  kind,
  at: new Date(NOW.getTime() - minutesAgo * 60_000),
  orderId: "o1",
  roundId: "r1",
  order: { dailyNumber: 14, table: { label: "7" } },
});

describe("ReceiptsService.pending", () => {
  it("offers both jobs of an accepted round to a station that has both printers", async () => {
    const { svc } = makeSvc([event("1", "round.accepted", 2)]);
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending.map((p) => p.job)).toEqual(["token", "kitchen"]);
  });

  it("offers only the jobs this station has a printer for", async () => {
    // Two machines: the counter holds token and bill, the kitchen holds
    // kitchen. One accept, one job each, both at the same moment.
    const { svc } = makeSvc([event("1", "round.accepted", 2)], [], ["kitchen"]);
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending.map((p) => p.job)).toEqual(["kitchen"]);
  });

  it("offers nothing for an event that produces no paper", async () => {
    const { svc } = makeSvc([event("1", "round.ready", 2), event("2", "round.cancelled", 1)]);
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending).toEqual([]);
  });

  it("does not re-offer a job this station already took", async () => {
    const { svc } = makeSvc(
      [event("1", "round.accepted", 2)],
      [{ eventId: BigInt("1"), job: "token", status: "printed" }],
    );
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending.map((p) => p.job)).toEqual(["kitchen"]);
  });

  it("still offers a job whose last attempt failed", async () => {
    // Paper jam, printer off, write died halfway. A failed receipt is not
    // a printed one, and the station must be able to try again. The mocked
    // findMany returns this row regardless of the `status: { not: "failed" }`
    // clause the real query carries, so this only passes if the service
    // itself also checks `status`, not just the eventId/job pair.
    const { svc } = makeSvc(
      [event("1", "round.accepted", 2)],
      [{ eventId: BigInt("1"), job: "token", status: "failed" }],
    );
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending.map((p) => p.job)).toEqual(["token", "kitchen"]);
  });

  it("puts anything older than thirty minutes in missed, not pending", async () => {
    // Review Focus 3. A machine switched on at closing time must not emit
    // the day's tickets; the owner decides which of them still matter.
    const { svc } = makeSvc([event("1", "round.accepted", 2), event("2", "round.accepted", 45)]);
    const { pending, missed } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending.every((p) => p.eventId === "1")).toBe(true);
    expect(missed.every((p) => p.eventId === "2")).toBe(true);
    expect(missed).not.toHaveLength(0);
  });

  it("treats exactly thirty minutes old as still pending, and one second past as missed", async () => {
    // The window test above only uses 2 and 45 minutes, which cannot tell a
    // `>` boundary from a `>=` one — both land in the same bucket either way.
    // This pins the actual edge: "thirty minutes back is pending" reads as
    // inclusive, so the cutoff instant itself must not be missed, and the
    // instant after it must be.
    const atBoundary = {
      id: BigInt("1"),
      kind: "round.accepted",
      at: new Date(NOW.getTime() - 30 * 60_000),
      orderId: "o1",
      roundId: "r1",
      order: { dailyNumber: 1, table: { label: "1" } },
    };
    const pastBoundary = {
      id: BigInt("2"),
      kind: "round.accepted",
      at: new Date(NOW.getTime() - 30 * 60_000 - 1),
      orderId: "o2",
      roundId: "r2",
      order: { dailyNumber: 2, table: { label: "2" } },
    };
    const { svc } = makeSvc([atBoundary, pastBoundary]);
    const { pending, missed } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending.some((p) => p.eventId === "1")).toBe(true);
    expect(missed.some((p) => p.eventId === "1")).toBe(false);
    expect(missed.some((p) => p.eventId === "2")).toBe(true);
    expect(pending.some((p) => p.eventId === "2")).toBe(false);
  });

  it("carries the table and token, so the screen can say what is waiting", async () => {
    // "2 tickets waiting" is not useful. "Table 7, token 14" is.
    const { svc } = makeSvc([event("1", "round.accepted", 2)]);
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending[0]).toMatchObject({ tableLabel: "7", token: 14, eventId: "1" });
  });

  it("answers with a topic even when the machine has no printer yet", async () => {
    // The page subscribes before it has been configured, and a station
    // with no outputs must not be a station with no socket.
    realtimeOn = true;
    const { svc } = makeSvc([event("1", "round.accepted", 2)], [], []);
    const out = await svc.pending("u1", "b1", "s1", NOW);
    expect(out.pending).toEqual([]);
    expect(out.topic).toBe(businessChannel("b1", "test-secret"));
  });

  it("hands out no topic when nothing will ever broadcast to it", async () => {
    // THE discriminating test. `REALTIME_CHANNEL_SECRET` has a dev default
    // in env.ts and is therefore never falsy, so an implementation keyed on
    // the secret instead of on usesRealtime() hands out a topic here — a
    // channel name for a socket nobody publishes to, which the station
    // subscribes to and waits on forever.
    realtimeOn = false;
    const { svc } = makeSvc([event("1", "round.accepted", 2)]);
    const out = await svc.pending("u1", "b1", "s1", NOW);
    expect(out.topic).toBeNull();
  });

  it("refreshes the station's last-seen timestamp on every poll", async () => {
    // "Last seen" is how a dashboard tells a live machine from a dead one,
    // and this endpoint is the only thing a working station ever calls. If
    // `touch` stopped being passed, a station left open all shift would look
    // offline the whole time.
    const { svc, stations } = makeSvc([event("1", "round.accepted", 2)]);
    await svc.pending("u1", "b1", "s1", NOW);
    expect(stations.resolve).toHaveBeenCalledWith("u1", "b1", "s1", { touch: true });
  });

  it("does not offer a bill job to a kitchen principal, even though the station holds a bill printer", async () => {
    // C1. The counter station holds token + bill; a kitchen-role staffer is
    // logged in on that tab. claim() already refuses a bill claim from
    // kitchen with a 403 — but pending() offering it at all is what let an
    // uncaught claim() throw wedge every job behind it in a station's pass
    // (see loop.spec.ts). pending() must agree with claim() about who may
    // have a bill, not just leave claim() to find out.
    const closed = {
      id: BigInt("1"),
      kind: "completed",
      at: new Date(NOW.getTime() - 2 * 60_000),
      orderId: "o1",
      roundId: null,
      order: { dailyNumber: 14, table: { label: "7" } },
    };
    const { svc, stations } = makeSvc([closed], [], ["token", "bill"], "kitchen");
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending.map((p) => p.job)).not.toContain("bill");
    expect(stations.roleFor).toHaveBeenCalledWith("u1", "b1");
  });

  it("still offers a bill job to the owner on the same station", async () => {
    // The other half of the above: the filter must discriminate on role, not
    // simply drop bill for everyone once a role check exists at all.
    const closed = {
      id: BigInt("1"),
      kind: "completed",
      at: new Date(NOW.getTime() - 2 * 60_000),
      orderId: "o1",
      roundId: null,
      order: { dailyNumber: 14, table: { label: "7" } },
    };
    const { svc } = makeSvc([closed], [], ["token", "bill"], "owner");
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending.map((p) => p.job)).toContain("bill");
  });

  it("never checks role when the station holds no bill output", async () => {
    // Every pending() poll that only prints token/kitchen must not pay for a
    // role lookup it has no reason to need.
    const { svc, stations } = makeSvc([event("1", "round.accepted", 2)], [], ["token", "kitchen"]);
    await svc.pending("u1", "b1", "s1", NOW);
    expect(stations.roleFor).not.toHaveBeenCalled();
  });

  it("re-offers a claim abandoned long enough ago, instead of leaving it stuck forever", async () => {
    // I1. A tab that closed mid-write, or a network drop, leaves a receipt
    // at `claimed` forever — excluded from `done` only by status, which
    // `pending`'s old query never revisited. Five minutes and one second
    // old is past STALE_CLAIM_MINUTES, so the job must come back.
    const { svc } = makeSvc(
      [event("1", "round.accepted", 2)],
      [
        {
          eventId: BigInt("1"),
          job: "token",
          status: "claimed",
          claimedAt: new Date(NOW.getTime() - 5 * 60_000 - 1000),
          attempt: 1,
          error: null,
        },
      ],
    );
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending.map((p) => p.job)).toEqual(["token", "kitchen"]);
  });

  it("does not re-offer a claim that is still well within the stale window", async () => {
    // The other edge of I1: a claim one second old is almost certainly a tab
    // about to finish writing, not an abandoned one, and must still read as
    // taken.
    const { svc } = makeSvc(
      [event("1", "round.accepted", 2)],
      [
        {
          eventId: BigInt("1"),
          job: "token",
          status: "claimed",
          claimedAt: new Date(NOW.getTime() - 1000),
          attempt: 1,
          error: null,
        },
      ],
    );
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending.map((p) => p.job)).toEqual(["kitchen"]);
  });

  it("lists a job whose latest attempt failed, with its error, in `failed`", async () => {
    // C2's visibility half: the error must survive to the screen, not just
    // the fact that a receipt exists.
    const { svc } = makeSvc(
      [event("1", "round.accepted", 2)],
      [
        {
          eventId: BigInt("1"),
          job: "token",
          status: "failed",
          claimedAt: new Date(NOW.getTime() - 60_000),
          attempt: 1,
          error: "device unavailable",
        },
      ],
    );
    const { failed } = await svc.pending("u1", "b1", "s1", NOW);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ job: "token", error: "device unavailable", attempt: 1 });
  });

  it("bounds the order_events query with a take limit, newest first", async () => {
    // I2: order_events is append-only and multi-tenant, and this query runs
    // every ten seconds per station with no bound at all. Newest-first,
    // because a cap on an ascending query would drop the events still
    // inside the 30-minute pending window first — exactly backwards.
    const { svc, prisma } = makeSvc([event("1", "round.accepted", 2)]);
    await svc.pending("u1", "b1", "s1", NOW);
    const call = (prisma.db.orderEvent.findMany as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { take?: number; orderBy?: { at: string } };
    expect(call.take).toBeGreaterThan(0);
    expect(call.orderBy).toEqual({ at: "desc" });
  });

  it("restores chronological order after the newest-first query", async () => {
    // The mock hands back exactly what it is given — here, deliberately in
    // the newest-first order the real `at: desc` query returns. Without
    // pending()'s own reverse, the station's list would show its newest
    // ticket first for no reason a later reader could explain.
    const older = event("1", "round.accepted", 10);
    const newer = event("2", "round.accepted", 2);
    const { svc } = makeSvc([newer, older]); // deliberately newest-first
    const { pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(pending.map((p) => p.eventId)).toEqual(["1", "1", "2", "2"]);
  });

  it("drops a failed attempt from `failed` once a later attempt on the same job printed", async () => {
    // Only the latest attempt decides the job's state. An attempt-1 failure
    // superseded by an attempt-2 success must not haunt the Failed list
    // forever.
    const { svc } = makeSvc(
      [event("1", "round.accepted", 2)],
      [
        {
          eventId: BigInt("1"),
          job: "token",
          status: "printed",
          claimedAt: new Date(NOW.getTime() - 30_000),
          attempt: 2,
          error: null,
        },
        {
          eventId: BigInt("1"),
          job: "token",
          status: "failed",
          claimedAt: new Date(NOW.getTime() - 90_000),
          attempt: 1,
          error: "device unavailable",
        },
      ],
    );
    const { failed, pending } = await svc.pending("u1", "b1", "s1", NOW);
    expect(failed).toEqual([]);
    expect(pending.map((p) => p.job)).toEqual(["kitchen"]);
  });
});
