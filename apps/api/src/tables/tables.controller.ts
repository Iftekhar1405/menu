import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  BadRequestException,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import type { RequestUser } from "../auth/jwt.strategy";
import { CurrentUser } from "../common/decorators";
import { ZodBody } from "../common/zod.pipe";
import { QrService } from "../qr/qr.service";
import { TablesService } from "./tables.service";

const createSchema = z.object({ label: z.string().trim().min(1).max(40) });

const rangeSchema = z.object({
  from: z.number().int().min(1).max(500),
  to: z.number().int().min(1).max(500),
  prefix: z.string().trim().max(20).default(""),
});

const patchSchema = z.object({
  label: z.string().trim().min(1).max(40).optional(),
  isActive: z.boolean().optional(),
});

@Controller("businesses/:bid/tables")
export class TablesController {
  constructor(
    private readonly tables: TablesService,
    private readonly qr: QrService,
  ) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Param("bid") bid: string) {
    return this.tables.list(user.id, bid);
  }

  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Body(new ZodBody(createSchema)) body: { label: string },
  ) {
    return this.tables.create(user.id, bid, body.label);
  }

  /** "Add tables 1 to 20" — the first thing most owners want to do. */
  @Post("range")
  async createRange(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Body(new ZodBody(rangeSchema)) body: z.infer<typeof rangeSchema>,
  ) {
    if (body.to < body.from) {
      throw new BadRequestException("The last table number must not be below the first");
    }
    if (body.to - body.from + 1 > 200) {
      throw new BadRequestException("Add at most 200 tables at a time");
    }
    const created = await this.tables.createRange(
      user.id,
      bid,
      body.from,
      body.to,
      body.prefix,
    );
    return { created };
  }

  @Patch(":id")
  update(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("id") id: string,
    @Body(new ZodBody(patchSchema)) body: z.infer<typeof patchSchema>,
  ) {
    return this.tables.update(user.id, bid, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("id") id: string,
  ) {
    await this.tables.remove(user.id, bid, id);
  }

  /**
   * The table's own card. Carries the table label under the business name so
   * a stack of twenty printed cards can be told apart before they go out.
   */
  @Get(":id/qr")
  async qrCard(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("id") id: string,
    @Query("format") format = "png",
    @Res() res: Response,
  ) {
    const table = await this.tables.get(user.id, bid, id);
    const filename = `table-${slugify(table.label)}-qr`;

    switch (format) {
      case "svg": {
        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}.svg"`);
        res.send(await this.qr.tableSvg(user.id, bid, id));
        return;
      }
      case "pdf": {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
        res.send(await this.qr.tablePdf(user.id, bid, id));
        return;
      }
      case "png": {
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}.png"`);
        res.send(await this.qr.tablePng(user.id, bid, id));
        return;
      }
      default:
        throw new BadRequestException("format must be png, pdf, or svg");
    }
  }
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "table";
}
