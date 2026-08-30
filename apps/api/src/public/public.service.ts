import { Injectable, NotFoundException } from "@nestjs/common";
import type { PublicMenu } from "@menu/shared";
import { MediaService } from "../media/media.service";
import { PrismaService } from "../prisma/prisma.service";

/** What the SQL function returns, before storage paths become URLs. */
interface RawPublicMenu extends Omit<PublicMenu, "business" | "categories"> {
  business: Omit<PublicMenu["business"], "logoUrl"> & { logoPath: string | null };
  categories: {
    id: string;
    name: string;
    items: (Omit<PublicMenu["categories"][number]["items"][number], "photos"> & {
      photos: { id: string; path: string; alt: string | null }[];
    })[];
  }[];
}

@Injectable()
export class PublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  /**
   * The whole diner-facing payload in one query.
   *
   * Deliberately not a set of Prisma includes: `get_public_menu` is the only
   * thing an anonymous path can reach, it filters hidden categories and
   * unavailable items in the database, and it takes a public code rather than
   * an id — so there is nothing here to enumerate.
   */
  async menuByCode(code: string): Promise<PublicMenu> {
    const rows = await this.prisma.$queryRaw<
      { get_public_menu: RawPublicMenu | null }[]
    >`SELECT get_public_menu(${code}) AS get_public_menu`;

    const raw = rows[0]?.get_public_menu;
    if (!raw) throw new NotFoundException("No menu found for that code");

    // Storage paths become URLs here rather than in SQL, so the database
    // stays ignorant of which storage driver is configured.
    return {
      ...raw,
      business: {
        ...raw.business,
        logoUrl: this.media.publicUrl(raw.business.logoPath),
      },
      categories: raw.categories.map((c) => ({
        ...c,
        items: c.items.map((i) => ({
          ...i,
          photos: i.photos.map((p) => ({
            id: p.id,
            url: this.media.publicUrl(p.path)!,
            alt: p.alt,
          })),
        })),
      })),
    } as PublicMenu;
  }

  /** Resolves a vanity slug to the permanent code the QR encodes. */
  async codeForSlug(slug: string): Promise<string> {
    const business = await this.prisma.business.findFirst({
      where: { vanitySlug: slug },
      select: { publicCode: true },
    });
    if (!business) throw new NotFoundException("No menu found");
    return business.publicCode;
  }

  /**
   * Fire-and-forget counter for the dashboard. Runs through a SECURITY
   * DEFINER function because the diner incrementing it owns nothing.
   */
  async recordView(code: string): Promise<void> {
    await this.prisma.$executeRaw`SELECT record_menu_view(${code})`;
  }
}
