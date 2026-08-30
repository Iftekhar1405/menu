import { Injectable, NotFoundException } from "@nestjs/common";
import { Resvg } from "@resvg/resvg-js";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import { readFile } from "node:fs/promises";
import { BusinessesService } from "../businesses/businesses.service";
import { TablesService } from "../tables/tables.service";
import { loadEnv, usesSupabaseStorage } from "../config/env";
import { MediaService } from "../media/media.service";
import { PrismaService } from "../prisma/prisma.service";
import { buildCardSvg } from "./card.svg";

/** A6 at 300 DPI: 105mm wide is 1240px. */
const PRINT_WIDTH_PX = 1240;

@Injectable()
export class QrService {
  private readonly env = loadEnv();

  constructor(
    private readonly businesses: BusinessesService,
    private readonly media: MediaService,
    private readonly tables: TablesService,
    private readonly prisma: PrismaService,
  ) {}

  private menuUrl(publicCode: string): string {
    return `${this.env.PUBLIC_MENU_BASE_URL}/m/${publicCode}`;
  }

  async svg(userId: string, businessId: string): Promise<string> {
    const business = await this.businesses.assertOwns(userId, businessId);
    return buildCardSvg({
      businessName: business.name,
      url: this.menuUrl(business.publicCode),
      logoDataUri: await this.logoDataUri(business.logoPath),
      accent: business.themeAccent,
    });
  }

  async png(userId: string, businessId: string): Promise<Buffer> {
    return this.rasterise(await this.svg(userId, businessId));
  }

  // ── Per-table cards ───────────────────────────────────────────────────────
  //
  // A table card encodes /t/<token>, not the menu URL. Scanning it binds the
  // device to that table and then redirects to the shared /order address, so
  // the table never appears anywhere the diner could edit it.

  async tableSvg(userId: string, businessId: string, tableId: string): Promise<string> {
    const business = await this.businesses.assertOwns(userId, businessId);
    const table = await this.tables.get(userId, businessId, tableId);

    return buildCardSvg({
      businessName: business.name,
      tableLabel: table.label,
      url: `${this.env.PUBLIC_MENU_BASE_URL}/t/${table.token}`,
      logoDataUri: await this.logoDataUri(business.logoPath),
      accent: business.themeAccent,
    });
  }

  async tablePng(userId: string, businessId: string, tableId: string): Promise<Buffer> {
    return this.rasterise(await this.tableSvg(userId, businessId, tableId));
  }

  async tablePdf(userId: string, businessId: string, tableId: string): Promise<Buffer> {
    return this.toPdf(await this.tableSvg(userId, businessId, tableId));
  }

  /**
   * A card for any business's table, without the ownership check.
   *
   * Used only by the platform admin fulfilling a merchandise order, where
   * printing someone else's table cards is the entire job. The gate is the
   * role check on the calling route — this method must never be reachable
   * from an owner-facing controller.
   */
  async adminTableSvg(businessId: string, tableId: string): Promise<string> {
    const business = await this.prismaBusiness(businessId);
    const table = await this.prismaTable(businessId, tableId);

    return buildCardSvg({
      businessName: business.name,
      tableLabel: table.label,
      url: `${this.env.PUBLIC_MENU_BASE_URL}/t/${table.token}`,
      logoDataUri: await this.logoDataUri(business.logoPath),
      accent: business.themeAccent,
    });
  }

  /**
   * One PDF, one page per table, in table order — what actually goes to the
   * print vendor. Sending twenty separate files is how a restaurant ends up
   * with two cards for table 7 and none for table 12.
   */
  async adminOrderArtwork(
    businessId: string,
    tableIds: string[],
  ): Promise<Buffer> {
    const svgs: string[] = [];
    for (const tableId of tableIds) {
      svgs.push(await this.adminTableSvg(businessId, tableId));
    }
    return this.toMultiPagePdf(svgs);
  }

  private async prismaBusiness(businessId: string) {
    // `db`, not the base client: the base client runs outside the request
    // transaction, where app.current_user_id is unset and RLS denies
    // everything — including the admin read policy this relies on.
    const business = await this.prisma.db.business.findUnique({
      where: { id: businessId },
    });
    if (!business) throw new NotFoundException("Business not found");
    return business;
  }

  private async prismaTable(businessId: string, tableId: string) {
    const table = await this.prisma.db.table.findFirst({
      where: { id: tableId, businessId },
    });
    if (!table) throw new NotFoundException("Table not found");
    return table;
  }

  private toMultiPagePdf(svgs: string[]): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: [297.64, 419.53], margin: 0, autoFirstPage: false });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      for (const svg of svgs) {
        doc.addPage({ size: [297.64, 419.53], margin: 0 });
        SVGtoPDF(doc, svg, 0, 0, { width: 297.64, height: 419.53, assumePt: false });
      }

      doc.end();
    });
  }

  private rasterise(svg: string): Buffer {
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: PRINT_WIDTH_PX },
      background: "#FFFFFF",
    });
    return Buffer.from(resvg.render().asPng());
  }

  /**
   * Vector PDF, not a PNG wrapped in a page. Print vendors need real vectors
   * for the PVC and epoxy cards, and a raster cannot be recovered into one.
   */
  async pdf(userId: string, businessId: string): Promise<Buffer> {
    return this.toPdf(await this.svg(userId, businessId));
  }

  private toPdf(svg: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      // A6 in PostScript points.
      const doc = new PDFDocument({ size: [297.64, 419.53], margin: 0 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      SVGtoPDF(doc, svg, 0, 0, { width: 297.64, height: 419.53, assumePt: false });
      doc.end();
    });
  }

  /** Logos are embedded as data URIs so the card renders with no network. */
  private async logoDataUri(logoPath: string | null): Promise<string | null> {
    if (!logoPath) return null;
    try {
      if (usesSupabaseStorage(this.env)) {
        const url = this.media.publicUrl(logoPath);
        if (!url) return null;
        const res = await fetch(url);
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return `data:${res.headers.get("content-type") ?? "image/webp"};base64,${buf.toString("base64")}`;
      }
      const bytes = await readFile(this.media.localFilePath(logoPath));
      return `data:image/webp;base64,${bytes.toString("base64")}`;
    } catch {
      // A missing logo must not stop an owner printing their QR.
      return null;
    }
  }
}
