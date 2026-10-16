import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { BusinessesService } from "./businesses.service";
import type { AccessRole } from "@menu/shared";

function service(rows: { business?: unknown; staff?: unknown }) {
  const prisma = {
    db: {
      business: { findFirst: vi.fn().mockResolvedValue(rows.business ?? null) },
      businessStaff: { findFirst: vi.fn().mockResolvedValue(rows.staff ?? null) },
    },
  };
  const svc = new BusinessesService(prisma as never, { revalidate: vi.fn() } as never);
  return { svc, prisma };
}

const BIZ = { id: "b1", name: "Cafe" };

describe("assertAccess", () => {
  it("lets an owner through by default", async () => {
    const { svc } = service({ business: BIZ });
    await expect(svc.assertAccess("u1", "b1")).resolves.toMatchObject({ role: "owner" });
  });

  it("refuses staff on a route that did not opt them in", async () => {
    const { svc, prisma } = service({ staff: { role: "kitchen", status: "active" } });
    await expect(svc.assertAccess("u2", "b1")).rejects.toBeInstanceOf(NotFoundException);
    // The default allow is owner-only, so staffRoles is empty and the staff
    // table is never even queried — nothing to opt in to.
    expect(prisma.db.businessStaff.findFirst).not.toHaveBeenCalled();
  });

  it("lets staff through when the route allows kitchen", async () => {
    const { svc, prisma } = service({
      staff: { role: "kitchen", status: "active", business: BIZ },
    });
    await expect(
      svc.assertAccess("u2", "b1", { allow: ["owner", "kitchen"] }),
    ).resolves.toMatchObject({ role: "kitchen" });
    // The security property under test is that this filtering happens in
    // the query itself, not in JS after the fetch — so pin the actual
    // `where` the service sent, not just the canned response it got back.
    expect(prisma.db.businessStaff.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          businessId: "b1",
          userId: "u2",
          status: "active",
          role: { in: ["kitchen"] },
        }),
      }),
    );
  });

  it("refuses a suspended staff member even on an opted-in route", async () => {
    const { svc, prisma } = service({ staff: null }); // the query filters status itself
    await expect(
      svc.assertAccess("u2", "b1", { allow: ["owner", "kitchen"] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Pin that `status: "active"` is really in the where clause. A mock
    // that just returns null regardless of arguments would pass even if
    // this filter had been moved into JS after the fetch — so assert on
    // the call the service actually made, not only on the outcome.
    expect(prisma.db.businessStaff.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "active" }),
      }),
    );
  });

  it("refuses an active staff member whose role is not in allow", async () => {
    // A future role (e.g. "manager") that is active but was never opted in
    // on this route. The real query's `role: { in: staffRoles } }` would
    // never match such a row, so the DB returns null — this pins that the
    // role filter is derived from `allow`, not left open, so a new role
    // never silently inherits another role's routes.
    const { svc, prisma } = service({ staff: null });
    await expect(
      svc.assertAccess("u2", "b1", { allow: ["owner", "kitchen"] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.db.businessStaff.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ role: { in: ["kitchen"] } }),
      }),
    );
    const allow: AccessRole[] = ["owner", "kitchen"];
    const calledWith = prisma.db.businessStaff.findFirst.mock.calls[0][0] as {
      where: { role: { in: string[] } };
    };
    expect(calledWith.where.role.in).not.toContain("manager" as unknown as AccessRole);
    expect(allow).not.toContain("manager" as unknown as AccessRole);
  });

  it("keeps assertOwns owner-only", async () => {
    const { svc } = service({ staff: { role: "kitchen", status: "active", business: BIZ } });
    await expect(svc.assertOwns("u2", "b1")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("listAccessible", () => {
  it("lists a user's own businesses, in order", async () => {
    const owned = [{ id: "b1" }, { id: "b2" }];
    const prisma = {
      db: {
        business: { findMany: vi.fn().mockResolvedValue(owned) },
        businessStaff: { findMany: vi.fn().mockResolvedValue([]) },
      },
    };
    const svc = new BusinessesService(prisma as never, { revalidate: vi.fn() } as never);
    await expect(svc.listAccessible("u1")).resolves.toEqual(owned);
  });

  it("includes businesses reached only as staff", async () => {
    const owned = [{ id: "b1" }];
    const staffedBiz = { id: "b2" };
    const prisma = {
      db: {
        business: { findMany: vi.fn().mockResolvedValue(owned) },
        businessStaff: {
          findMany: vi.fn().mockResolvedValue([
            { role: "kitchen", status: "active", business: staffedBiz },
          ]),
        },
      },
    };
    const svc = new BusinessesService(prisma as never, { revalidate: vi.fn() } as never);
    await expect(svc.listAccessible("u2")).resolves.toEqual([owned[0], staffedBiz]);
  });

  it("de-duplicates a business the user both owns and actively staffs", async () => {
    const biz = { id: "b1", name: "Cafe" };
    const prisma = {
      db: {
        business: { findMany: vi.fn().mockResolvedValue([biz]) },
        businessStaff: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ role: "kitchen", status: "active", business: biz }]),
        },
      },
    };
    const svc = new BusinessesService(prisma as never, { revalidate: vi.fn() } as never);
    const result = await svc.listAccessible("owner-who-is-also-staff");
    expect(result).toHaveLength(1);
    expect(result).toEqual([biz]);
  });
});
