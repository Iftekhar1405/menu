import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import type { RequestUser } from "../auth/jwt.strategy";
import { CurrentUser, Roles } from "../common/decorators";
import { ZodBody } from "../common/zod.pipe";
import { QrService } from "../qr/qr.service";
import { MerchService } from "./merch.service";

const requestSchema = z.object({
  contactName: z.string().trim().min(1).max(120),
  contactPhone: z.string().trim().min(6).max(20),
  contactEmail: z.string().trim().email().max(254).nullish(),
  addressLine1: z.string().trim().min(1).max(160),
  addressLine2: z.string().trim().max(160).nullish(),
  city: z.string().trim().min(1).max(80),
  state: z.string().trim().min(1).max(80),
  postalCode: z.string().trim().min(4).max(12),
  country: z.string().trim().length(2).default("IN"),
  notes: z.string().trim().max(1000).nullish(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(0).max(2000).default(0),
        tableIds: z.array(z.string().uuid()).max(500).default([]),
      }),
    )
    .min(1)
    .max(10),
});

const adminPatchSchema = z.object({
  status: z
    .enum([
      "requested",
      "quoted",
      "confirmed",
      "in_production",
      "shipped",
      "delivered",
      "cancelled",
    ])
    .optional(),
  adminNotes: z.string().trim().max(2000).nullish(),
  quotedTotal: z.number().min(0).max(10_000_000).nullish(),
});

/** Owner-facing: the catalogue, and their own requests. */
@Controller()
export class MerchController {
  constructor(private readonly merch: MerchService) {}

  @Get("merch/products")
  catalogue() {
    return this.merch.catalogue();
  }

  @Get("businesses/:bid/merch-orders")
  mine(@CurrentUser() user: RequestUser, @Param("bid") bid: string) {
    return this.merch.listForBusiness(user.id, bid);
  }

  @Post("businesses/:bid/merch-orders")
  request(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Body(new ZodBody(requestSchema)) body: z.infer<typeof requestSchema>,
  ) {
    return this.merch.request(user.id, bid, body);
  }
}

/**
 * Ours only.
 *
 * Every route here reads across businesses, which happens nowhere else in the
 * system. Two things gate it: `@Roles("platform_admin")` on the controller, and
 * the second clause on the merch RLS policies. Neither is sufficient alone —
 * the role check stops the request, the policy stops the query.
 */
@Roles("platform_admin")
@Controller("admin/merch")
export class AdminMerchController {
  constructor(
    private readonly merch: MerchService,
    private readonly qr: QrService,
  ) {}

  @Get("orders")
  list(@Query("status") status?: string) {
    const allowed = [
      "requested",
      "quoted",
      "confirmed",
      "in_production",
      "shipped",
      "delivered",
      "cancelled",
    ];
    if (status && !allowed.includes(status)) {
      throw new BadRequestException("Unknown status");
    }
    return this.merch.listAll(status as never);
  }

  @Get("orders/:id")
  get(@Param("id") id: string) {
    return this.merch.adminGet(id);
  }

  @Patch("orders/:id")
  update(
    @Param("id") id: string,
    @Body(new ZodBody(adminPatchSchema)) body: z.infer<typeof adminPatchSchema>,
  ) {
    // Absent and null mean different things here. Coercing `undefined` to
    // `null` would make a status-only PATCH silently wipe the quote and the
    // internal notes saved a moment earlier, which is exactly what it did.
    return this.merch.adminUpdate(id, {
      ...(body.status !== undefined && { status: body.status }),
      ...("adminNotes" in body && { adminNotes: body.adminNotes ?? null }),
      ...("quotedTotal" in body && { quotedTotal: body.quotedTotal ?? null }),
    });
  }

  /**
   * The print file: one page per table, in table order. This is the reason
   * admin access crosses the tenant boundary at all.
   */
  @Get("orders/:id/artwork")
  async artwork(@Param("id") id: string, @Res() res: Response) {
    const { order, tables } = await this.merch.tablesForOrder(id);

    if (tables.length === 0) {
      throw new BadRequestException(
        "This order names no tables, so there is no per-table artwork to print",
      );
    }

    const pdf = await this.qr.adminOrderArtwork(
      order.businessId,
      tables.map((t) => t.id),
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="merch-${order.orderNumber}-artwork.pdf"`,
    );
    res.send(pdf);
  }
}
