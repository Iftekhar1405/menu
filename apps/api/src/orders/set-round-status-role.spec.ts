import { describe, expect, it, vi } from "vitest";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { OrdersService } from "./orders.service";

/**
 * The round-level half of the role matrix.
 *
 * `canRoleSetStatus` is shared with the order-level path, so this file is not
 * re-testing the table — it is testing that the round path asks it at all,
 * and in the right order against the state machine. A round is smaller than
 * an order; the rule about who may close one is not.
 */
function service(role: "owner" | "kitchen", from: string) {
  const businesses = {
    assertAccess: vi.fn().mockResolvedValue({ business: { id: "b1" }, role }),
  };
  const prisma = {
    db: {
      orderRound: {
        findFirst: vi.fn().mockResolvedValue({ id: "r1", status: from, seq: 2 }),
        update: vi.fn().mockResolvedValue({ id: "r1" }),
      },
      order: {
        findFirstOrThrow: vi
          .fn()
          .mockResolvedValue({ id: "o1", rounds: [], items: [], cancellations: [] }),
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
  return Object.assign(orders, { __prisma: prisma });
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
