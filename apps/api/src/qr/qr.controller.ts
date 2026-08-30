import { BadRequestException, Controller, Get, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import type { RequestUser } from "../auth/jwt.strategy";
import { BusinessesService } from "../businesses/businesses.service";
import { CurrentUser } from "../common/decorators";
import { QrService } from "./qr.service";

@Controller("businesses/:id/qr")
export class QrController {
  constructor(
    private readonly qr: QrService,
    private readonly businesses: BusinessesService,
  ) {}

  @Get()
  async download(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Query("format") format = "png",
    @Res() res: Response,
  ) {
    const business = await this.businesses.assertOwns(user.id, id);
    const filename = `${slugify(business.name)}-menu-qr`;

    switch (format) {
      case "svg": {
        const svg = await this.qr.svg(user.id, id);
        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}.svg"`);
        res.send(svg);
        return;
      }
      case "pdf": {
        const pdf = await this.qr.pdf(user.id, id);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
        res.send(pdf);
        return;
      }
      case "png": {
        const png = await this.qr.png(user.id, id);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}.png"`);
        res.send(png);
        return;
      }
      default:
        throw new BadRequestException("format must be png, pdf, or svg");
    }
  }
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "business"
  );
}
