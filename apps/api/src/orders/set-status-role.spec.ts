import { describe, expect, it, vi } from "vitest";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { OrdersService } from "./orders.service";

/**
 * @param from    the order's status going in, which is derived from its rounds
 * @param derived what the derivation leaves the order at once the rounds have
 *                moved — what `orderForBoard` reads back, not what was asked
 *                for. Defaults to `from`, for the tests that never get that far.
 */
function service(
  role: "owner" | "kitchen",
  from: string,
  { derived = from }: { derived?: string } = {},
) {
  const businesses = {
    assertAccess: vi.fn().mockResolvedValue({ business: { id: "b1" }, role }),
  };
  const prisma = {
    db: {
      order: {
        findFirst: vi.fn().mockResolvedValue({ id: "o1", status: from }),
        update: vi.fn().mockResolvedValue({ id: "o1" }),
        // What the board is told, read back after the write rather than
        // returned by it — see orderForBoard.
        findFirstOrThrow: vi.fn().mockResolvedValue({
          id: "o1",
          tableId: "t1",
          status: derived,
          rounds: [],
          items: [],
          cancellations: [],
        }),
      },
      orderRound: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    },
  };
  const notifications = { announceStatus: vi.fn(), announceReachedKitchen: vi.fn() };
  const orders = new OrdersService(
    prisma as never,
    businesses as never,
    {} as never,
    notifications as never,
  );
  return Object.assign(orders, { __prisma: prisma, __notifications: notifications });
}

/** The one round-moving statement this call issued. */
function roundWrite(s: ReturnType<typeof service>) {
  const calls = s.__prisma.db.orderRound.updateMany.mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][0] as {
    where: { orderId: string; status: { in: string[] } };
    data: { status: string; acceptedAt?: Date; completedAt?: Date };
  };
}

describe("setStatus by role", () => {
  it("lets the kitchen mark an order ready", async () => {
    const s = service("kitchen", "preparing", { derived: "ready" });
    await expect(s.setStatus("u", "b1", "o1", "ready" as never)).resolves.toBeTruthy();
  });

  it("refuses the kitchen `completed` with a 403, not a 409", async () => {
    const s = service("kitchen", "ready");
    await expect(s.setStatus("u", "b1", "o1", "completed" as never))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses the kitchen `cancelled`", async () => {
    const s = service("kitchen", "placed");
    await expect(s.setStatus("u", "b1", "o1", "cancelled" as never))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  // An impossible move is still a 409 for everyone: it is the order's state
  // that refuses, not the person's role.
  it("keeps a backward move a conflict for the owner", async () => {
    const s = service("owner", "completed");
    await expect(s.setStatus("u", "b1", "o1", "placed" as never))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it("lets the owner complete an order", async () => {
    const s = service("owner", "ready", { derived: "completed" });
    await expect(s.setStatus("u", "b1", "o1", "completed" as never)).resolves.toBeTruthy();
  });

  // `accepted` IS a legal kitchen target, but not from `ready` — the move
  // itself is backwards. This must stay a 409, not a 403: ALLOWED_TRANSITIONS
  // has to be checked before canRoleSetStatus, because canRoleSetStatus
  // already folds the transition check in and would make this pass silently
  // if someone "simplified" setStatus down to that one call.
  it("keeps a backward move to a role-legal status a conflict, not a role refusal", async () => {
    const s = service("kitchen", "ready");
    await expect(s.setStatus("u", "b1", "o1", "accepted" as never))
      .rejects.toBeInstanceOf(ConflictException);
  });

  // The kitchen's bell holds a new order back until it is accepted, and
  // nothing else on this path reaches the staff topic. Without this ping the
  // kitchen would not hear about the order until the next unrelated event.
  it("wakes the staff feed when an order reaches the kitchen", async () => {
    const s = service("owner", "placed", { derived: "accepted" });
    await s.setStatus("u", "b1", "o1", "accepted" as never);
    expect(s.__notifications.announceReachedKitchen).toHaveBeenCalledWith("b1");
  });

  // The owner may skip `accepted`. Keying the wake on that one status would
  // leave the kitchen's bell holding a row for an order already on its board.
  it("wakes it for a move that skips straight past accepted", async () => {
    const s = service("owner", "placed", { derived: "preparing" });
    await s.setStatus("u", "b1", "o1", "preparing" as never);
    expect(s.__notifications.announceReachedKitchen).toHaveBeenCalledWith("b1");
  });

  it("stays quiet once the order is already on the board", async () => {
    const s = service("kitchen", "preparing", { derived: "ready" });
    await s.setStatus("u", "b1", "o1", "ready" as never);
    expect(s.__notifications.announceReachedKitchen).not.toHaveBeenCalled();
  });

  it("stays quiet for an order cancelled before anyone cooked it", async () => {
    const s = service("owner", "placed", { derived: "cancelled" });
    await s.setStatus("u", "b1", "o1", "cancelled" as never);
    expect(s.__notifications.announceReachedKitchen).not.toHaveBeenCalled();
  });
});

/**
 * What closing a table — or moving one along — now does to its rounds.
 *
 * `orders.status` is derived from the rounds by trigger. This method's job is
 * to move the rounds; the column follows. Anything it writes to the column
 * itself is a second author for one fact, and the two disagree the moment a
 * round moves on its own.
 */
describe("setStatus and the table's rounds", () => {
  // A live round left behind holds the order open through the derivation, so
  // the table the owner just closed reappears on the board with a second bill
  // owing. Closing a table means finishing everything still live on it — and
  // only what is still live: a chai cancelled an hour ago is not completed
  // when the table is.
  it("completes every live round, and nothing already ended", async () => {
    const s = service("owner", "preparing", { derived: "completed" });

    await s.setStatus("u", "b1", "o1", "completed" as never);

    const write = roundWrite(s);
    expect(write.where.orderId).toBe("o1");
    expect(write.where.status.in).toEqual([
      "placed",
      "accepted",
      "preparing",
      "ready",
    ]);
    expect(write.data.status).toBe("completed");
  });

  // The defect this task removes: the method used to write orders.status by
  // hand beside the trigger that derives it. The hand-written value survives
  // only until the next round moves, which then silently replaces it with
  // whatever the rounds actually say.
  it("never writes the order's own status", async () => {
    const s = service("owner", "ready", { derived: "completed" });
    await s.setStatus("u", "b1", "o1", "completed" as never);
    expect(s.__prisma.db.order.update).not.toHaveBeenCalled();
  });

  // An order's status is its LEAST advanced live round, so a table reading
  // "Being made" can already hold a round that is ready. Tapping Ready on it
  // is a legal move on the order and a no-op on that round — refusing the
  // whole call because one round had nowhere left to go would make exactly
  // the multi-round table this feature exists for unservable.
  it("passes over a round already at `next` instead of refusing the call", async () => {
    const s = service("kitchen", "preparing", { derived: "ready" });

    await expect(s.setStatus("u", "b1", "o1", "ready" as never)).resolves.toBeTruthy();

    expect(roundWrite(s).where.status.in).toEqual([
      "placed",
      "accepted",
      "preparing",
    ]);
  });

  // Same rule as setRoundStatus: a timestamp this move did not produce stays
  // out of the UPDATE entirely. Stamping completed_at on a round that only
  // started cooking would tell every later reader it was served — and
  // order_rounds_kitchen_guard rejects a staff write that names the column at
  // all, so this is also what keeps the kitchen's own buttons working.
  it("stamps no completion time on a round that only started cooking", async () => {
    const s = service("kitchen", "accepted", { derived: "preparing" });

    await s.setStatus("u", "b1", "o1", "preparing" as never);

    expect(roundWrite(s).data).toMatchObject({
      status: "preparing",
      acceptedAt: undefined,
      completedAt: undefined,
    });
  });

  it("stamps one on the rounds the owner closes", async () => {
    const s = service("owner", "ready", { derived: "completed" });

    await s.setStatus("u", "b1", "o1", "completed" as never);

    expect(roundWrite(s).data.completedAt).toBeInstanceOf(Date);
  });
});
