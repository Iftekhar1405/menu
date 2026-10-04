import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Business } from "@prisma/client";
import type { AccessRole, BusinessUpdateInput } from "@menu/shared";
import { PrismaService } from "../prisma/prisma.service";
import { RevalidateClient } from "../public/revalidate.client";

export interface BusinessAccess {
  business: Business;
  role: AccessRole;
}

@Injectable()
export class BusinessesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revalidate: RevalidateClient,
  ) {}

  /**
   * The single door through which a business id becomes usable.
   *
   * `allow` defaults to owner-only, which is the whole point: a route that
   * nobody thought about stays closed. Opening one to staff is a visible
   * edit at the call site, not something a role check elsewhere can do by
   * accident.
   */
  async assertAccess(
    userId: string,
    businessId: string,
    opts: { allow?: AccessRole[] } = {},
  ): Promise<BusinessAccess> {
    const allow = opts.allow ?? ["owner"];

    if (allow.includes("owner")) {
      const business = await this.prisma.db.business.findFirst({
        where: { id: businessId, ownerId: userId },
      });
      if (business) return { business, role: "owner" };
    }

    const staffRoles = allow.filter((r): r is Exclude<AccessRole, "owner"> => r !== "owner");
    if (staffRoles.length > 0) {
      const member = await this.prisma.db.businessStaff.findFirst({
        where: {
          businessId,
          userId,
          status: "active",
          role: { in: staffRoles },
        },
        include: { business: true },
      });
      if (member) return { business: member.business, role: member.role };
    }

    // The same 404 either way. That a business exists is not something a
    // stranger needs confirmed.
    throw new NotFoundException("Business not found");
  }

  /**
   * Every menu, media, and QR operation resolves its business through here
   * first, so an id from a URL is never trusted on its own. RLS would already
   * hide another tenant's rows; this turns that silence into an honest 404
   * and keeps the check visible in the code rather than only in the database.
   *
   * Owner-only. Unchanged for all existing call sites.
   */
  async assertOwns(userId: string, businessId: string): Promise<Business> {
    const { business } = await this.assertAccess(userId, businessId, { allow: ["owner"] });
    return business;
  }

  /**
   * Every business this user can reach, as owner or as staff.
   *
   * A business the user both owns and is an active staff row on (nothing
   * stops that combination existing) must appear once, not twice — this
   * list feeds a venue switcher, and a duplicate there reads as a bug, not
   * a security hole. Owned businesses win the slot; order is otherwise
   * owned-first, each half by `createdAt asc`, same as before.
   */
  async listAccessible(userId: string): Promise<Business[]> {
    const owned = await this.prisma.db.business.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: "asc" },
    });
    const staffed = await this.prisma.db.businessStaff.findMany({
      where: { userId, status: "active" },
      include: { business: true },
      orderBy: { createdAt: "asc" },
    });
    const ownedIds = new Set(owned.map((b) => b.id));
    const staffedOnly = staffed
      .map((s) => s.business)
      .filter((b) => !ownedIds.has(b.id));
    return [...owned, ...staffedOnly];
  }

  /** Kept: existing callers ask for "mine" meaning "owned". */
  async listMine(userId: string): Promise<Business[]> {
    return this.prisma.db.business.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: "asc" },
    });
  }

  async update(
    userId: string,
    businessId: string,
    patch: BusinessUpdateInput,
  ): Promise<Business> {
    await this.assertOwns(userId, businessId);

    if (patch.vanitySlug) {
      const clash = await this.prisma.business.findFirst({
        where: { vanitySlug: patch.vanitySlug, NOT: { id: businessId } },
        select: { id: true },
      });
      if (clash) throw new ConflictException("That menu address is already taken");
    }

    // publicCode and ownerId are absent from BusinessUpdateInput by design —
    // the first is printed on physical cards, the second is the tenant
    // boundary. Neither is patchable through this route.
    const updated = await this.prisma.db.business.update({
      where: { id: businessId },
      data: {
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.type !== undefined && { type: patch.type }),
        ...(patch.addressLine1 !== undefined && { addressLine1: patch.addressLine1 }),
        ...(patch.addressLine2 !== undefined && { addressLine2: patch.addressLine2 }),
        ...(patch.city !== undefined && { city: patch.city }),
        ...(patch.state !== undefined && { state: patch.state }),
        ...(patch.postalCode !== undefined && { postalCode: patch.postalCode }),
        ...(patch.country !== undefined && { country: patch.country }),
        ...(patch.logoPath !== undefined && { logoPath: patch.logoPath }),
        ...(patch.themeLayout !== undefined && { themeLayout: patch.themeLayout }),
        ...(patch.themeAccent !== undefined && { themeAccent: patch.themeAccent }),
        ...(patch.themeFont !== undefined && { themeFont: patch.themeFont }),
        ...(patch.vanitySlug !== undefined && { vanitySlug: patch.vanitySlug }),
        ...(patch.runningOrderEnabled !== undefined && {
          runningOrderEnabled: patch.runningOrderEnabled,
        }),
        ...(patch.runningOrderWindowMins !== undefined && {
          runningOrderWindowMins: patch.runningOrderWindowMins,
        }),
        ...(patch.cancellationEnabled !== undefined && {
          cancellationEnabled: patch.cancellationEnabled,
        }),
        ...(patch.cancellationWindowMins !== undefined && {
          cancellationWindowMins: patch.cancellationWindowMins,
        }),
        ...(patch.cancellationStatuses !== undefined && {
          cancellationStatuses: patch.cancellationStatuses,
        }),
        ...(patch.cancellationItemsEnabled !== undefined && {
          cancellationItemsEnabled: patch.cancellationItemsEnabled,
        }),
        menuUpdatedAt: new Date(),
      },
    });

    await this.revalidate.menu(updated.publicCode);
    return updated;
  }

  /** Dashboard tiles: what is missing, and how often the menu is being seen. */
  async summary(userId: string, businessId: string) {
    await this.assertOwns(userId, businessId);

    const [categories, items, missingPhotos, views] = await Promise.all([
      this.prisma.db.menuCategory.count({ where: { businessId } }),
      this.prisma.db.menuItem.count({ where: { businessId } }),
      this.prisma.db.menuItem.count({
        where: { businessId, photos: { none: {} } },
      }),
      this.prisma.db.menuView.findMany({
        where: {
          businessId,
          viewedOn: { gte: new Date(Date.now() - 30 * 86_400_000) },
        },
        select: { viewedOn: true, count: true },
      }),
    ]);

    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const views7 = views
      .filter((v) => v.viewedOn >= sevenDaysAgo)
      .reduce((sum, v) => sum + v.count, 0);
    const views30 = views.reduce((sum, v) => sum + v.count, 0);

    return {
      categories,
      items,
      itemsMissingPhotos: missingPhotos,
      views7,
      views30,
    };
  }
}
