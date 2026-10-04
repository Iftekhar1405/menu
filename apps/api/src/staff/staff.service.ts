import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomInt } from "node:crypto";
import type { StaffCreateInput } from "@menu/shared";
import { PrismaService } from "../prisma/prisma.service";
import { PinService } from "../auth/pin.service";
import { TokenService } from "../auth/token.service";
import { BusinessesService } from "../businesses/businesses.service";
import { identifierWhere, parseIdentifier } from "../auth/identifier";

/** randomInt, not Math.random: this is a credential. */
function mintPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pins: PinService,
    private readonly tokens: TokenService,
    private readonly businesses: BusinessesService,
  ) {}

  async list(userId: string, businessId: string) {
    await this.businesses.assertOwns(userId, businessId);
    return this.prisma.db.businessStaff.findMany({
      where: { businessId },
      include: {
        user: { select: { id: true, fullName: true, email: true, phone: true, mustChangePin: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Creates the account and hands its PIN back once.
   *
   * Owner-created rather than invited: there is no transactional email or SMS
   * configured for this path, and an account whose first use depends on an
   * OTP that may never arrive is an account that does not work on day one.
   */
  async create(userId: string, businessId: string, input: StaffCreateInput) {
    await this.businesses.assertOwns(userId, businessId);
    const identifier = parseIdentifier(input.identifier, input.country);
    const conflictMessage =
      identifier.kind === "email"
        ? "An account already uses that email address"
        : "An account already uses that phone number";

    // Deliberately the same wording signup uses. A different message here
    // would turn this endpoint into a way to ask which phone numbers have
    // accounts. The base client, not prisma.db: this must see every account
    // regardless of tenant, or a phone number already used in another
    // business's tenant could be claimed again here.
    const existing = await this.prisma.user.findFirst({ where: identifierWhere(identifier) });
    if (existing) {
      throw new ConflictException(conflictMessage);
    }

    const pin = mintPin();
    const pinHash = await this.pins.hashPin(pin);

    // No nested $transaction here: inside a request this runs on the
    // transaction TenantInterceptor already opened, and prisma.db is that
    // transaction's client — a fresh $transaction would run on a different
    // connection with no app.current_user_id set, and business_staff's
    // FORCE ROW LEVEL SECURITY policy would refuse the insert. Outside a
    // request (a seed script, a background job) prisma.db falls back to the
    // base client with no transaction at all: a failed businessStaff.create
    // after a successful user.create would leave an orphaned User behind.
    // Every current caller is a request handler, so this is a caveat for a
    // future caller, not a bug today.
    let user;
    try {
      user = await this.prisma.db.user.create({
        data: {
          email: identifier.kind === "email" ? identifier.email : null,
          phone: identifier.kind === "phone" ? identifier.phone : null,
          pinHash,
          fullName: input.fullName,
          role: "kitchen",
          // The owner vouching is the verification; there is no channel to
          // send a code on.
          verifiedAt: new Date(),
          mustChangePin: true,
        },
      });
    } catch (err) {
      // TOCTOU: two concurrent creates for the same identifier can both pass
      // the findFirst above before either inserts. The loser hits the @unique
      // constraint — surface it as the same 409 the earlier check gives,
      // not a raw 500.
      if (isUniqueViolation(err)) throw new ConflictException(conflictMessage);
      throw err;
    }
    const staff = await this.prisma.db.businessStaff.create({
      data: { businessId, userId: user.id, role: "kitchen", createdById: userId },
      include: { user: { select: { id: true, fullName: true, email: true, phone: true, mustChangePin: true } } },
    });

    // The only time this value exists outside a hash.
    return { staff, pin };
  }

  async setStatus(userId: string, businessId: string, staffId: string, status: "active" | "suspended") {
    const row = await this.find(userId, businessId, staffId);
    const updated = await this.prisma.db.businessStaff.update({
      where: { id: row.id },
      data: { status },
    });
    // Access tokens live 15 minutes. Without this, someone suspended
    // mid-service keeps working until their token happens to expire.
    if (status === "suspended") await this.tokens.revokeAllForUser(row.userId);
    return updated;
  }

  async resetPin(userId: string, businessId: string, staffId: string) {
    const row = await this.find(userId, businessId, staffId);
    const pin = mintPin();
    await this.prisma.db.user.update({
      where: { id: row.userId },
      data: {
        pinHash: await this.pins.hashPin(pin),
        mustChangePin: true,
        failedAttempts: 0,
        lockedUntil: null,
      },
    });
    await this.tokens.revokeAllForUser(row.userId);
    return { pin };
  }

  async remove(userId: string, businessId: string, staffId: string) {
    const row = await this.find(userId, businessId, staffId);
    await this.prisma.db.businessStaff.delete({ where: { id: row.id } });

    // The identifier is globally @unique, and staff turnover is routine: if
    // the User row is left behind, re-adding this person — at this venue or
    // any other — fails forever with "already in use", with no UI path out.
    // Delete the account too, but only when it is provably safe:
    //  - they own no business (deleting them would cascade a whole venue
    //    away — never do that from a staff-removal path);
    //  - they have no remaining business_staff row anywhere (another owner
    //    may still depend on this exact login at a different venue; removing
    //    them from *this* business must never end their access elsewhere).
    //
    // Both tables are FORCE RLS keyed on the connection's identity, and with
    // no identity set a query sees nothing at all (NULLIF(...)::uuid is NULL,
    // every comparison is NULL) — so querying as the *acting owner* would
    // always read back zero and delete unconditionally, which is exactly the
    // unsafe outcome this guard exists to prevent. The owner policy on
    // `businesses` and the self-read policy on `business_staff` both key on
    // this exact departing user's id, so — borrowing the technique
    // auth.service.signup uses before there is a tenant identity — this
    // assumes the departing user's own identity for the read, then restores
    // the acting owner's before doing anything else.
    await this.prisma.db.$executeRaw`SELECT set_config('app.current_user_id', ${row.userId}::text, true)`;
    let ownedCount: number;
    let remainingStaffCount: number;
    try {
      [ownedCount, remainingStaffCount] = await Promise.all([
        this.prisma.db.business.count({ where: { ownerId: row.userId } }),
        this.prisma.db.businessStaff.count({ where: { userId: row.userId } }),
      ]);
    } finally {
      await this.prisma.db.$executeRaw`SELECT set_config('app.current_user_id', ${userId}::text, true)`;
    }
    if (ownedCount === 0 && remainingStaffCount === 0) {
      await this.prisma.db.user.delete({ where: { id: row.userId } });
    }

    await this.tokens.revokeAllForUser(row.userId);
  }

  private async find(userId: string, businessId: string, staffId: string) {
    await this.businesses.assertOwns(userId, businessId);
    const row = await this.prisma.db.businessStaff.findFirst({
      where: { id: staffId, businessId },
    });
    if (!row) throw new NotFoundException("Staff member not found");
    return row;
  }
}
