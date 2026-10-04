import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { BusinessesService } from "./businesses.service";

function service(rows: { business?: unknown; staff?: unknown }) {
  const prisma = {
    db: {
      business: { findFirst: vi.fn().mockResolvedValue(rows.business ?? null) },
      businessStaff: { findFirst: vi.fn().mockResolvedValue(rows.staff ?? null) },
    },
  };
  return new BusinessesService(prisma as never, { revalidate: vi.fn() } as never);
}

const BIZ = { id: "b1", name: "Cafe" };

describe("assertAccess", () => {
  it("lets an owner through by default", async () => {
    const s = service({ business: BIZ });
    await expect(s.assertAccess("u1", "b1")).resolves.toMatchObject({ role: "owner" });
  });

  it("refuses staff on a route that did not opt them in", async () => {
    const s = service({ staff: { role: "kitchen", status: "active" } });
    await expect(s.assertAccess("u2", "b1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("lets staff through when the route allows kitchen", async () => {
    const s = service({ staff: { role: "kitchen", status: "active", business: BIZ } });
    await expect(
      s.assertAccess("u2", "b1", { allow: ["owner", "kitchen"] }),
    ).resolves.toMatchObject({ role: "kitchen" });
  });

  it("refuses a suspended staff member even on an opted-in route", async () => {
    const s = service({ staff: null }); // the query filters status itself
    await expect(
      s.assertAccess("u2", "b1", { allow: ["owner", "kitchen"] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("keeps assertOwns owner-only", async () => {
    const s = service({ staff: { role: "kitchen", status: "active", business: BIZ } });
    await expect(s.assertOwns("u2", "b1")).rejects.toBeInstanceOf(NotFoundException);
  });
});
