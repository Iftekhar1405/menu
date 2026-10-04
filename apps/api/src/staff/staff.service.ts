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

    // Before any possible user deletion, not after: RefreshToken.user is
    // onDelete: Cascade, and revokeAllForUser's updateMany runs on the base
    // client — a different, outside-the-transaction connection. Deleting the
    // user first would hold an uncommitted cascade lock on refresh_tokens
    // while that outside query waits on the same rows, and since Postgres
    // sees one waiter rather than a cycle, deadlock detection never fires —
    // the request just hangs until the tenant transaction times out. The
    // cascade removes those rows anyway, so revoking first is both correct
    // and harmless whether or not the user ends up deleted below.
    await this.tokens.revokeAllForUser(row.userId);

    // The identifier is globally @unique, and staff turnover is routine: if
    // the User row is left behind, re-adding this person — at this venue or
    // any other — fails forever with "already in use", with no UI path out.
    // Delete the account too, but only when app_user_is_detachable says it is
    // safe: they own no business, and have no remaining business_staff row
    // at any other venue.
    //
    // That check cannot be a plain query here. `businesses` and
    // `business_staff` are both FORCE RLS, keyed on the connection's
    // identity, and policies only show the *caller's own* rows — so asking
    // "does this other user own anything, anywhere" as the acting owner
    // would read back nothing, not everything, and invert the guard into
    // deleting unconditionally. (An earlier version of this guard tried to
    // route around that by temporarily borrowing the departing user's
    // identity with set_config; that is also wrong outside a request, where
    // prisma.db falls back to the base client and set_config(..., true) is
    // discarded before the next statement runs.) app_user_is_detachable is a
    // SECURITY DEFINER function that answers this one question — and only
    // for a user staffing a business the caller actually owns, so it cannot
    // be asked about an arbitrary account — without the caller's own
    // identity ever changing.
    const [{ detachable }] = await this.prisma.db.$queryRaw<{ detachable: boolean }[]>`
      SELECT app_user_is_detachable(${row.userId}::uuid, ${businessId}::uuid) AS detachable
    `;
    if (detachable) {
      await this.prisma.db.user.delete({ where: { id: row.userId } });
    }
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
