import { describe, expect, it, vi } from "vitest";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { OrdersService } from "./orders.service";

function service(role: "owner" | "kitchen", from: string) {
  const businesses = {
    assertAccess: vi.fn().mockResolvedValue({ business: { id: "b1" }, role }),
  };
  const prisma = {
    db: {
      order: {
        findFirst: vi.fn().mockResolvedValue({ id: "o1", status: from }),
        update: vi.fn().mockResolvedValue({ id: "o1", status: "ready", items: [], cancellations: [] }),
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
  return Object.assign(orders, { __notifications: notifications });
}

describe("setStatus by role", () => {
  it("lets the kitchen mark an order ready", async () => {
    const s = service("kitchen", "preparing");
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
    const s = service("owner", "ready");
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
    const s = service("owner", "placed");
    await s.setStatus("u", "b1", "o1", "accepted" as never);
    expect(s.__notifications.announceReachedKitchen).toHaveBeenCalledWith("b1");
  });

  // The owner may skip `accepted`. Keying the wake on that one status would
  // leave the kitchen's bell holding a row for an order already on its board.
  it("wakes it for a move that skips straight past accepted", async () => {
    const s = service("owner", "placed");
    await s.setStatus("u", "b1", "o1", "preparing" as never);
    expect(s.__notifications.announceReachedKitchen).toHaveBeenCalledWith("b1");
  });

  it("stays quiet once the order is already on the board", async () => {
    const s = service("kitchen", "preparing");
    await s.setStatus("u", "b1", "o1", "ready" as never);
    expect(s.__notifications.announceReachedKitchen).not.toHaveBeenCalled();
  });

  it("stays quiet for an order cancelled before anyone cooked it", async () => {
    const s = service("owner", "placed");
    await s.setStatus("u", "b1", "o1", "cancelled" as never);
    expect(s.__notifications.announceReachedKitchen).not.toHaveBeenCalled();
  });
});
