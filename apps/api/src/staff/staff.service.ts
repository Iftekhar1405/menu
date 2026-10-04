import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
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

    // Deliberately the same wording signup uses. A different message here
    // would turn this endpoint into a way to ask which phone numbers have
    // accounts. The base client, not prisma.db: this must see every account
    // regardless of tenant, or a phone number already used in another
    // business's tenant could be claimed again here.
    const existing = await this.prisma.user.findFirst({ where: identifierWhere(identifier) });
    if (existing) {
      throw new ConflictException(
        identifier.kind === "email"
          ? "An account already uses that email address"
          : "An account already uses that phone number",
      );
    }

    const pin = mintPin();
    const pinHash = await this.pins.hashPin(pin);

    // No nested $transaction here: the request is already inside the
    // transaction TenantInterceptor opened, and prisma.db is that
    // transaction's client. A fresh $transaction would run on a different
    // connection with no app.current_user_id set, and business_staff's
    // FORCE ROW LEVEL SECURITY policy would refuse the insert.
    const user = await this.prisma.db.user.create({
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
