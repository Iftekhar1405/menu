import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { z } from "zod";
import type { RequestUser } from "../auth/jwt.strategy";
import { BusinessesService } from "../businesses/businesses.service";
import { CurrentUser, Public } from "../common/decorators";
import { ZodBody } from "../common/zod.pipe";
import { loadEnv } from "../config/env";
import { MediaService } from "./media.service";

const itemUploadSchema = z.object({
  businessId: z.string().uuid(),
  itemId: z.string().uuid(),
});

@Controller("media")
export class MediaController {
  private readonly env = loadEnv();

  constructor(
    private readonly media: MediaService,
    private readonly businesses: BusinessesService,
  ) {}

  @Post("upload-url")
  async itemUploadUrl(
    @CurrentUser() user: RequestUser,
    @Body(new ZodBody(itemUploadSchema)) body: z.infer<typeof itemUploadSchema>,
  ) {
    await this.businesses.assertOwns(user.id, body.businessId);
    return this.media.createUploadUrl(body.businessId, "item", body.itemId);
  }

  /**
   * Local storage driver, used when Supabase credentials are absent.
   *
   * The browser uploads here without a bearer token, exactly as it would to a
   * cloud signed URL, so the route is @Public — which would make it an open
   * write endpoint if left there. The HMAC below is what actually authorises
   * it: the API signs `path.expiry` when it issues the ticket, and nothing
   * else can mint one.
   */
  @Public()
  @Put("local/*")
  async uploadLocal(
    @Req() req: Request,
    @Query("token") token: string,
    @Query("exp") exp: string,
  ) {
    const path = decodeURIComponent(req.params[0] ?? "");
    this.assertSignature(path, exp, token);

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);

    if (bytes.length === 0) throw new BadRequestException("Empty upload");
    if (bytes.length > 8 * 1024 * 1024) {
      throw new BadRequestException("File is larger than 8MB");
    }

    await this.media.saveLocal(path, bytes);
    return { path };
  }

  @Public()
  @Get("local/*")
  serveLocal(@Req() req: Request, @Res() res: Response) {
    const path = decodeURIComponent(req.params[0] ?? "");
    // Reject traversal outright rather than trying to normalise it.
    if (path.includes("..")) throw new BadRequestException("Invalid path");

    const full = this.media.localFilePath(path);
    if (!existsSync(full)) {
      res.status(404).json({ message: "Not found" });
      return;
    }
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    createReadStream(full).pipe(res);
  }

  private assertSignature(path: string, exp: string, token: string): void {
    if (!exp || !token) throw new UnauthorizedException("Upload link is not valid");
    if (Number(exp) < Date.now()) {
      throw new UnauthorizedException("Upload link has expired");
    }

    const expected = createHmac("sha256", this.env.REVALIDATE_SECRET)
      .update(`${path}.${exp}`)
      .digest("hex");

    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException("Upload link is not valid");
    }
  }
}
