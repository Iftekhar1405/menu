import { Injectable, NotFoundException } from "@nestjs/common";
import type { CategoryInput, MenuItemInput } from "@menu/shared";
import { BusinessesService } from "../businesses/businesses.service";
import { PrismaService } from "../prisma/prisma.service";
import { RevalidateClient } from "../public/revalidate.client";

/**
 * All menu mutations.
 *
 * Every method takes `userId` and resolves the business through
 * BusinessesService.assertOwns before touching anything — a business id from
 * a URL is an assertion by the client, not a fact. Each mutation also runs
 * inside the request's tenant transaction (see TenantInterceptor), so the
 * deferred price-guard trigger sees the finished state at commit rather than
 * a half-built item mid-write.
 */
@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businesses: BusinessesService,
    private readonly revalidate: RevalidateClient,
  ) {}

  // ── Reading ───────────────────────────────────────────────────────────────

  /** The owner's view: everything, including hidden and unavailable rows. */
  async fullMenu(userId: string, businessId: string) {
    await this.businesses.assertOwns(userId, businessId);
    return this.prisma.db.menuCategory.findMany({
      where: { businessId },
      orderBy: { position: "asc" },
      include: {
        items: {
          orderBy: { position: "asc" },
          include: {
            variants: { orderBy: { position: "asc" } },
            photos: { orderBy: { position: "asc" } },
          },
        },
      },
    });
  }

  // ── Categories ────────────────────────────────────────────────────────────

  async createCategory(userId: string, businessId: string, input: CategoryInput) {
    await this.businesses.assertOwns(userId, businessId);
    const last = await this.prisma.db.menuCategory.findFirst({
      where: { businessId },
      orderBy: { position: "desc" },
      select: { position: true },
    });

    const created = await this.prisma.db.menuCategory.create({
      data: {
        businessId,
        name: input.name,
        isVisible: input.isVisible,
        position: (last?.position ?? -1) + 1,
      },
    });
    await this.touch(businessId);
    return created;
  }

  async updateCategory(
    userId: string,
    businessId: string,
    categoryId: string,
    input: Partial<CategoryInput>,
  ) {
    await this.businesses.assertOwns(userId, businessId);
    await this.assertCategoryBelongs(businessId, categoryId);

    const updated = await this.prisma.db.menuCategory.update({
      where: { id: categoryId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.isVisible !== undefined && { isVisible: input.isVisible }),
      },
    });
    await this.touch(businessId);
    return updated;
  }

  async deleteCategory(userId: string, businessId: string, categoryId: string) {
    await this.businesses.assertOwns(userId, businessId);
    await this.assertCategoryBelongs(businessId, categoryId);
    await this.prisma.db.menuCategory.delete({ where: { id: categoryId } });
    await this.touch(businessId);
  }

  async reorderCategories(userId: string, businessId: string, ids: string[]) {
    await this.businesses.assertOwns(userId, businessId);
    // Positions are rewritten wholesale rather than swapped, so a reorder is
    // idempotent and cannot leave gaps or duplicates behind.
    for (const [index, id] of ids.entries()) {
      await this.prisma.db.menuCategory.updateMany({
        where: { id, businessId },
        data: { position: index },
      });
    }
    await this.touch(businessId);
  }

  // ── Items ─────────────────────────────────────────────────────────────────

  async createItem(userId: string, businessId: string, input: MenuItemInput) {
    await this.businesses.assertOwns(userId, businessId);
    await this.assertCategoryBelongs(businessId, input.categoryId);

    const last = await this.prisma.db.menuItem.findFirst({
      where: { categoryId: input.categoryId },
      orderBy: { position: "desc" },
      select: { position: true },
    });

    const item = await this.prisma.db.menuItem.create({
      data: {
        businessId,
        categoryId: input.categoryId,
        name: input.name,
        // Null whenever variants carry the price. The schema refuses both at
        // once, and so does the database.
        price: input.variants.length > 0 ? null : (input.price ?? null),
        description: input.description ?? null,
        isAvailable: input.isAvailable,
        position: (last?.position ?? -1) + 1,
        dietTag: input.dietTag ?? null,
        spiceLevel: input.spiceLevel ?? null,
        prepTimeMins: input.prepTimeMins ?? null,
        ingredients: input.ingredients ?? null,
        allergens: input.allergens,
        nutrition: input.nutrition ?? undefined,
      },
    });

    await this.replaceVariants(businessId, item.id, input.variants);
    await this.replacePhotos(businessId, item.id, input.photos);
    await this.touch(businessId);

    return this.itemWithChildren(item.id);
  }

  async updateItem(
    userId: string,
    businessId: string,
    itemId: string,
    input: MenuItemInput,
  ) {
    await this.businesses.assertOwns(userId, businessId);
    await this.assertItemBelongs(businessId, itemId);
    await this.assertCategoryBelongs(businessId, input.categoryId);

    await this.prisma.db.menuItem.update({
      where: { id: itemId },
      data: {
        categoryId: input.categoryId,
        name: input.name,
        price: input.variants.length > 0 ? null : (input.price ?? null),
        description: input.description ?? null,
        isAvailable: input.isAvailable,
        dietTag: input.dietTag ?? null,
        spiceLevel: input.spiceLevel ?? null,
        prepTimeMins: input.prepTimeMins ?? null,
        ingredients: input.ingredients ?? null,
        allergens: input.allergens,
        nutrition: input.nutrition ?? undefined,
      },
    });

    await this.replaceVariants(businessId, itemId, input.variants);
    await this.replacePhotos(businessId, itemId, input.photos);
    await this.touch(businessId);

    return this.itemWithChildren(itemId);
  }

  async deleteItem(userId: string, businessId: string, itemId: string) {
    await this.businesses.assertOwns(userId, businessId);
    await this.assertItemBelongs(businessId, itemId);
    await this.prisma.db.menuItem.delete({ where: { id: itemId } });
    await this.touch(businessId);
  }

  async setItemAvailability(
    userId: string,
    businessId: string,
    itemId: string,
    isAvailable: boolean,
  ) {
    await this.businesses.assertOwns(userId, businessId);
    await this.assertItemBelongs(businessId, itemId);
    const updated = await this.prisma.db.menuItem.update({
      where: { id: itemId },
      data: { isAvailable },
    });
    await this.touch(businessId);
    return updated;
  }

  async reorderItems(
    userId: string,
    businessId: string,
    categoryId: string,
    ids: string[],
  ) {
    await this.businesses.assertOwns(userId, businessId);
    await this.assertCategoryBelongs(businessId, categoryId);

    for (const [index, id] of ids.entries()) {
      // categoryId is written too, so dragging an item between categories is
      // the same operation as reordering within one.
      await this.prisma.db.menuItem.updateMany({
        where: { id, businessId },
        data: { position: index, categoryId },
      });
    }
    await this.touch(businessId);
  }

  // ── Children ──────────────────────────────────────────────────────────────

  /**
   * Variants and photos are replaced wholesale rather than diffed. The lists
   * are short, the client always sends the full set, and a full replace has
   * no partial-update failure modes to reason about.
   */
  private async replaceVariants(
    businessId: string,
    itemId: string,
    variants: MenuItemInput["variants"],
  ): Promise<void> {
    await this.prisma.db.menuItemVariant.deleteMany({ where: { itemId } });
    if (variants.length === 0) return;

    await this.prisma.db.menuItemVariant.createMany({
      data: variants.map((v, i) => ({
        itemId,
        businessId,
        name: v.name,
        price: v.price,
        position: i,
      })),
    });
  }

  private async replacePhotos(
    businessId: string,
    itemId: string,
    photos: MenuItemInput["photos"],
  ): Promise<void> {
    await this.prisma.db.menuItemPhoto.deleteMany({ where: { itemId } });
    if (photos.length === 0) return;

    await this.prisma.db.menuItemPhoto.createMany({
      data: photos.map((p, i) => ({
        itemId,
        businessId,
        storagePath: p.storagePath,
        alt: p.alt ?? null,
        position: i,
      })),
    });
  }

  private itemWithChildren(itemId: string) {
    return this.prisma.db.menuItem.findUnique({
      where: { id: itemId },
      include: {
        variants: { orderBy: { position: "asc" } },
        photos: { orderBy: { position: "asc" } },
      },
    });
  }

  // ── Guards ────────────────────────────────────────────────────────────────

  private async assertCategoryBelongs(businessId: string, categoryId: string) {
    const found = await this.prisma.db.menuCategory.findFirst({
      where: { id: categoryId, businessId },
      select: { id: true },
    });
    if (!found) throw new NotFoundException("Category not found");
  }

  private async assertItemBelongs(businessId: string, itemId: string) {
    const found = await this.prisma.db.menuItem.findFirst({
      where: { id: itemId, businessId },
      select: { id: true },
    });
    if (!found) throw new NotFoundException("Item not found");
  }

  /** Bumps the menu timestamp and pushes the public page a new version. */
  private async touch(businessId: string): Promise<void> {
    const business = await this.prisma.db.business.update({
      where: { id: businessId },
      data: { menuUpdatedAt: new Date() },
      select: { publicCode: true },
    });
    await this.revalidate.menu(business.publicCode);
  }
}
