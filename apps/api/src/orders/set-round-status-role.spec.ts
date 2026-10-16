import { describe, expect, it, vi } from "vitest";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { OrdersService } from "./orders.service";
import { priceKeys } from "./price-keys.testutil";

/**
 * The round-level half of the role matrix, and what a round move tells the
 * rest of the system.
 *
 * `canRoleSetStatus` is shared with the order-level path, so this file is not
 * re-testing the table — it is testing that the round path asks it at all,
 * and in the right order against the state machine. A round is smaller than
 * an order; the rule about who may close one is not.
 */
function service(
  role: "owner" | "kitchen",
  from: string,
  order: { before: string; after: string } = { before: "placed", after: "preparing" },
) {
  const businesses = {
    assertAccess: vi.fn().mockResolvedValue({ business: { id: "b1" }, role }),
  };
  const prisma = {
    db: {
      orderRound: {
        findFirst: vi.fn().mockResolvedValue({
          id: "r1",
          status: from,
          seq: 2,
          order: { status: order.before },
        }),
        update: vi.fn().mockResolvedValue({ id: "r1" }),
      },
      order: {
        // The board shape as Prisma really hands it back, prices and all —
        // the same include listForBusiness strips. stripPrices is not mocked;
        // the leak test below depends on the real one running.
        findFirstOrThrow: vi.fn().mockResolvedValue({
          id: "o1",
          tableId: "t1",
          status: order.after,
          items: [
            { id: "i1", nameSnapshot: "Dosa", quantity: 2, unitPrice: "120.00", lineTotal: "240.00" },
          ],
          rounds: [
            {
              id: "r1",
              seq: 2,
              kotNumber: 7,
              status: "ready",
              items: [{ id: "i1", nameSnapshot: "Dosa", quantity: 2, unitPrice: "120.00" }],
            },
          ],
          cancellations: [
            { id: "c1", nameSnapshot: "Idli", quantity: 1, unitPrice: "60.00" },
          ],
        }),
        update: vi.fn(),
      },
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

describe("setRoundStatus by role", () => {
  it("lets the kitchen move a round to ready", async () => {
    const s = service("kitchen", "preparing");
    await expect(
      s.setRoundStatus("u", "b1", "o1", "r1", "ready" as never),
    ).resolves.toBeDefined();
  });

  // `completed` is what closes an order for billing — a service act. The rule
  // does not get weaker because the thing being closed got smaller.
  it("refuses the kitchen `completed` on a round, as it does on an order", async () => {
    const s = service("kitchen", "ready");
    await expect(
      s.setRoundStatus("u", "b1", "o1", "r1", "completed" as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // Two different refusals on purpose: the state machine refusing is a fact
  // about the round; a role refusing is a fact about the person. ALLOWED_
  // TRANSITIONS has to be checked before canRoleSetStatus, which already
  // folds the transition check in and would make this a 403 if someone
  // "simplified" the method down to that one call.
  it("refuses a backwards move with a 409, not a 403", async () => {
    const s = service("owner", "ready");
    await expect(
      s.setRoundStatus("u", "b1", "o1", "r1", "accepted" as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // The order's status is derived from every round by trigger. Writing it
  // here as well would be two authors for one fact, and they would disagree
  // the first time two rounds moved at once.
  it("never writes the order's own status", async () => {
    const s = service("owner", "ready");
    await s.setRoundStatus("u", "b1", "o1", "r1", "completed" as never);
    expect(s.__prisma.db.order.update).not.toHaveBeenCalled();
  });
});

describe("setRoundStatus and money", () => {
  // The response is the board shape, and a kitchen account is an expected
  // caller of this route — so every line's unit price was going back over the
  // wire to someone the rest of the product shows no prices to. A response
  // that has left the server has leaked whatever is in it; what the browser
  // then renders is not the question.
  it("sends the kitchen no prices, at any depth", async () => {
    const s = service("kitchen", "preparing");
    const out = await s.setRoundStatus("u", "b1", "o1", "r1", "ready" as never);
    expect(priceKeys(out)).toEqual([]);
  });

  // The other half: a guard that emptied the payload would pass the test
  // above for the wrong reason, and the owner's board needs those prices.
  it("leaves the owner's prices alone", async () => {
    const s = service("owner", "preparing");
    const out = await s.setRoundStatus("u", "b1", "o1", "r1", "ready" as never);
    expect(priceKeys(out)).toContain("unitPrice");
  });
});

describe("setRoundStatus announcements", () => {
  // The diner's payload carries the rounds themselves, so accepting KOT 1
  // while KOT 2 is still waiting changes their screen even though the order
  // stays `placed`. Keying the ping on the derived status would leave them
  // on a stale screen in exactly the multi-round case this feature is for.
  it("tells the table even when the order's own status did not move", async () => {
    const s = service("kitchen", "placed", { before: "placed", after: "placed" });
    await s.setRoundStatus("u", "b1", "o1", "r1", "accepted" as never);
    expect(s.__notifications.announceStatus).toHaveBeenCalledWith("t1");
  });

  // The kitchen's bell holds the diner's "New order" row back until the
  // ORDER reaches their board. Once rounds are what staff advance, this is
  // the only path that releases it — without this the kitchen would not hear
  // about the order until the next unrelated event.
  it("wakes the staff feed when the order it belongs to reaches the kitchen", async () => {
    const s = service("kitchen", "placed", { before: "placed", after: "accepted" });
    await s.setRoundStatus("u", "b1", "o1", "r1", "accepted" as never);
    expect(s.__notifications.announceReachedKitchen).toHaveBeenCalledWith("b1");
  });

  // Unlike the table ping, the bell is not free: it is keyed on a one-time
  // visibility change, and ringing it on every round move would make it noise.
  it("stays quiet once the order is already on the board", async () => {
    const s = service("kitchen", "preparing", { before: "accepted", after: "ready" });
    await s.setRoundStatus("u", "b1", "o1", "r1", "ready" as never);
    expect(s.__notifications.announceReachedKitchen).not.toHaveBeenCalled();
  });
});
