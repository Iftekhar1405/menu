import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NotFoundException } from "@nestjs/common";
import { StaffService } from "./staff.service";

interface BuildOptions {
  /** What the base-client identifier check finds. Non-null means "taken". */
  existingUser?: unknown;
  /** What `find`'s scoped lookup returns. `null` simulates a cross-tenant id. */
  staffRow?: { id: string; userId: string; businessId: string } | null;
  /** How many businesses the departing user owns, for `remove`'s guard. */
  ownedCount?: number;
  /** How many business_staff rows the departing user still has, for `remove`'s guard. */
  remainingStaffCount?: number;
  /** Override `user.create`, e.g. to simulate a unique-constraint race. */
  userCreate?: () => unknown;
}

// `create` writes through `prisma.db`, not a fresh `$transaction`: the
// request is already inside the transaction TenantInterceptor opened, and
// `prisma.db` is that transaction's client. A nested `$transaction` would run
// outside it with no `app.current_user_id` set, and `business_staff`'s
// FORCE ROW LEVEL SECURITY policy would refuse the insert.
function build(opts: BuildOptions = {}) {
  const {
    existingUser = null,
    staffRow = { id: "s1", userId: "u9", businessId: "b1" },
    ownedCount = 0,
    remainingStaffCount = 0,
  } = opts;

  const executeRaw = vi.fn().mockResolvedValue(undefined);

  const prisma = {
    db: {
      user: {
        create: opts.userCreate
          ? vi.fn(opts.userCreate)
          : vi.fn().mockResolvedValue({ id: "u9", fullName: "Ramesh" }),
        update: vi.fn().mockResolvedValue({ id: "u9" }),
        delete: vi.fn().mockResolvedValue({ id: "u9" }),
      },
      businessStaff: {
        create: vi.fn().mockResolvedValue({
          id: "s1",
          userId: "u9",
          user: { id: "u9", fullName: "Ramesh", email: null, phone: "+919876543210", mustChangePin: true },
        }),
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(staffRow),
        update: vi.fn().mockResolvedValue({ id: "s1", status: "suspended" }),
        delete: vi.fn().mockResolvedValue({ id: "s1" }),
        count: vi.fn().mockResolvedValue(remainingStaffCount),
      },
      business: {
        count: vi.fn().mockResolvedValue(ownedCount),
      },
      $executeRaw: executeRaw,
    },
    // The base client: identifier-uniqueness must see every account
    // regardless of tenant, so it is checked here, not through `db`.
    user: { findFirst: vi.fn().mockResolvedValue(existingUser) },
  };
  const pins = { hashPin: vi.fn().mockResolvedValue("hashed") };
  const tokens = { revokeAllForUser: vi.fn().mockResolvedValue(undefined) };
  const businesses = { assertOwns: vi.fn().mockResolvedValue({ id: "b1" }) };
  const svc = new StaffService(prisma as never, pins as never, tokens as never, businesses as never);
  return { svc, prisma, tokens, pins, executeRaw };
}

describe("staff creation", () => {
  it("returns a six-digit PIN exactly once", async () => {
    const { svc } = build();
    const out = await svc.create("owner1", "b1", { fullName: "Ramesh", identifier: "+919876543210", country: "IN" });
    expect(out.pin).toMatch(/^\d{6}$/);
  });

  it("never stores the PIN in plaintext", async () => {
    const { svc, pins } = build();
    const out = await svc.create("owner1", "b1", { fullName: "Ramesh", identifier: "+919876543210", country: "IN" });
    expect(pins.hashPin).toHaveBeenCalledWith(out.pin);
  });

  it("forces a PIN change on the new account", async () => {
    const { svc } = build();
    const out = await svc.create("owner1", "b1", { fullName: "Ramesh", identifier: "+919876543210", country: "IN" });
    expect(out.staff.user.mustChangePin ?? true).toBe(true);
  });

  // Review Focus 2: this endpoint must not become an account oracle.
  it("refuses a taken identifier in signup's exact words", async () => {
    const { svc } = build({ existingUser: { id: "existing" } });
    await expect(
      svc.create("owner1", "b1", { fullName: "Ramesh", identifier: "+919876543210", country: "IN" }),
    ).rejects.toThrow("An account already uses that phone number");
  });

  // Fix round 1, Important 1: nothing previously asserted the actual data
  // sent to the database. Dropping `role: "kitchen"` from the implementation
  // would silently default the account to `owner` — the schema default —
  // and every pre-existing test stayed green. Verified by deletion: with
  // `role: "kitchen"` removed from staff.service.ts, this test fails
  // (`expected "owner" to be "kitchen"`); restored, it passes again.
  it("constrains the new account: kitchen role, forced PIN change, owner-vouched verification, hashed PIN", async () => {
    const { svc, prisma, pins } = build();
    pins.hashPin.mockResolvedValue("hashed-pin-value");
    const out = await svc.create("owner1", "b1", { fullName: "Ramesh", identifier: "+919876543210", country: "IN" });

    expect(prisma.db.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        role: "kitchen",
        mustChangePin: true,
        pinHash: "hashed-pin-value",
      }),
    });
    const payload = prisma.db.user.create.mock.calls[0][0].data;
    expect(payload.verifiedAt).toBeInstanceOf(Date);
    // The hash, never the plaintext PIN the caller receives.
    expect(payload.pinHash).not.toBe(out.pin);
  });

  it("records which owner created the staff row", async () => {
    const { svc, prisma } = build();
    await svc.create("owner1", "b1", { fullName: "Ramesh", identifier: "+919876543210", country: "IN" });
    expect(prisma.db.businessStaff.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ businessId: "b1", userId: "u9", createdById: "owner1" }),
      }),
    );
  });

  // Minor 1: a TOCTOU window between the uniqueness check and the insert.
  // Two concurrent creates for the same identifier can both pass the
  // findFirst check before either inserts; the loser must see the same 409
  // signup gives, not a raw 500 from an unhandled unique-constraint error.
  it("turns a concurrent unique-constraint race into the same conflict signup gives", async () => {
    const raceError = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5.22.0",
    });
    const { svc } = build({
      userCreate: () => {
        throw raceError;
      },
    });
    await expect(
      svc.create("owner1", "b1", { fullName: "Ramesh", identifier: "+919876543210", country: "IN" }),
    ).rejects.toThrow("An account already uses that phone number");
  });
});

describe("find: business-scoped lookup", () => {
  // Fix round 1, Important 2: this must filter by businessId, not just id —
  // otherwise a staff id from another owner's venue would resolve here.
  it("scopes the lookup to both the staff id and the business id", async () => {
    const { svc, prisma } = build();
    await svc.setStatus("owner1", "b1", "s1", "suspended");
    expect(prisma.db.businessStaff.findFirst).toHaveBeenCalledWith({
      where: { id: "s1", businessId: "b1" },
    });
  });

  it("refuses a staff id that belongs to another business", async () => {
    const { svc } = build({ staffRow: null });
    await expect(svc.setStatus("owner1", "b1", "s1", "suspended")).rejects.toThrow(NotFoundException);
  });
});

describe("ending access", () => {
  // Review Focus 1: a valid 15-minute token must not outlive suspension.
  it("revokes every session when suspending", async () => {
    const { svc, tokens } = build();
    await svc.setStatus("owner1", "b1", "s1", "suspended");
    expect(tokens.revokeAllForUser).toHaveBeenCalledWith("u9");
  });

  it("revokes every session when removing", async () => {
    const { svc, tokens } = build();
    await svc.remove("owner1", "b1", "s1");
    expect(tokens.revokeAllForUser).toHaveBeenCalledWith("u9");
  });

  it("revokes every session when resetting a PIN", async () => {
    const { svc, tokens } = build();
    await svc.resetPin("owner1", "b1", "s1");
    expect(tokens.revokeAllForUser).toHaveBeenCalledWith("u9");
  });

  it("does not revoke when merely reactivating", async () => {
    const { svc, tokens } = build();
    await svc.setStatus("owner1", "b1", "s1", "active");
    expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
  });

  // Minor 3: the single behaviour that lets an owner hand a locked-out
  // person a PIN they can actually use.
  it("clears lockout state when resetting a PIN", async () => {
    const { svc, prisma } = build();
    await svc.resetPin("owner1", "b1", "s1");
    expect(prisma.db.user.update).toHaveBeenCalledWith({
      where: { id: "u9" },
      data: expect.objectContaining({ failedAttempts: 0, lockedUntil: null }),
    });
  });
});

describe("remove: the user account behind a removed staff row", () => {
  // Important 3: the identifier is globally @unique. Leaving the User behind
  // after removing their business_staff row would make re-adding this exact
  // person — anywhere, ever — fail forever with "already in use".
  it("deletes a plain kitchen account entirely, with no other ties", async () => {
    const { svc, prisma } = build({ ownedCount: 0, remainingStaffCount: 0 });
    await svc.remove("owner1", "b1", "s1");
    expect(prisma.db.user.delete).toHaveBeenCalledWith({ where: { id: "u9" } });
  });

  it("keeps the account when the user still staffs another venue", async () => {
    const { svc, prisma } = build({ ownedCount: 0, remainingStaffCount: 1 });
    await svc.remove("owner1", "b1", "s1");
    expect(prisma.db.user.delete).not.toHaveBeenCalled();
  });

  it("never deletes a user who owns a business", async () => {
    const { svc, prisma } = build({ ownedCount: 1, remainingStaffCount: 0 });
    await svc.remove("owner1", "b1", "s1");
    expect(prisma.db.user.delete).not.toHaveBeenCalled();
  });
});
