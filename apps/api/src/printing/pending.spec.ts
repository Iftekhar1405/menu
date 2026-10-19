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

function makeSvc(events: unknown[], receipts: unknown[] = [], outputs = ["token", "kitchen"]) {
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
  };
  return { svc: new ReceiptsService(prisma as never, stations as never), prisma, stations };
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
});
