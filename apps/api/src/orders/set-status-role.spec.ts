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
  const notifications = { announceStatus: vi.fn() };
  return new OrdersService(
    prisma as never,
    businesses as never,
    {} as never,
    notifications as never,
  );
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
});
