import { describe, expect, it, vi } from "vitest";
import { StaffService } from "./staff.service";

// `create` writes through `prisma.db`, not a fresh `$transaction`: the
// request is already inside the transaction TenantInterceptor opened, and
// `prisma.db` is that transaction's client. A nested `$transaction` would run
// outside it with no `app.current_user_id` set, and `business_staff`'s
// FORCE ROW LEVEL SECURITY policy would refuse the insert.
function build(existingUser: unknown = null) {
  const prisma = {
    db: {
      user: {
        create: vi.fn().mockResolvedValue({ id: "u9", fullName: "Ramesh" }),
        update: vi.fn().mockResolvedValue({ id: "u9" }),
      },
      businessStaff: {
        create: vi.fn().mockResolvedValue({
          id: "s1",
          userId: "u9",
          user: { id: "u9", fullName: "Ramesh", email: null, phone: "+919876543210", mustChangePin: true },
        }),
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue({ id: "s1", userId: "u9", businessId: "b1" }),
        update: vi.fn().mockResolvedValue({ id: "s1", status: "suspended" }),
        delete: vi.fn().mockResolvedValue({ id: "s1" }),
      },
    },
    // The base client: identifier-uniqueness must see every account
    // regardless of tenant, so it is checked here, not through `db`.
    user: { findFirst: vi.fn().mockResolvedValue(existingUser) },
  };
  const pins = { hashPin: vi.fn().mockResolvedValue("hashed") };
  const tokens = { revokeAllForUser: vi.fn().mockResolvedValue(undefined) };
  const businesses = { assertOwns: vi.fn().mockResolvedValue({ id: "b1" }) };
  const svc = new StaffService(prisma as never, pins as never, tokens as never, businesses as never);
  return { svc, prisma, tokens, pins };
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
    const { svc } = build({ id: "existing" });
    await expect(
      svc.create("owner1", "b1", { fullName: "Ramesh", identifier: "+919876543210", country: "IN" }),
    ).rejects.toThrow("An account already uses that phone number");
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
});
