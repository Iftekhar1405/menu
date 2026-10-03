import { Body, Controller, Get, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { markPaidSchema, salesFilterSchema, type MarkPaidInput, type SalesFilter } from "@menu/shared";
import type { RequestUser } from "../auth/jwt.strategy";
import { CurrentUser } from "../common/decorators";
import { ZodBody } from "../common/zod.pipe";
import { AnalyticsService } from "./analytics.service";
import { SalesService } from "./sales.service";

const pdfBatchSchema = z.object({ billIds: z.array(z.string().uuid()).min(1).max(25) });

/**
 * The owner's sales record. Authenticated by the global guard; every handler
 * goes through assertOwns in the service, and every query runs on the tenant
 * transaction, so RLS is the second wall.
 */
@Controller("businesses/:bid")
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly analytics: AnalyticsService,
  ) {}

  @Get("bills")
  list(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Query(new ZodBody(salesFilterSchema)) filter: SalesFilter,
    @Query("cursor") cursor?: string,
  ) {
    return this.sales.list(user.id, bid, filter, cursor);
  }

  @Patch("bills/:billId/payment-mode")
  changeMode(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("billId") billId: string,
    @Body(new ZodBody(markPaidSchema)) body: MarkPaidInput,
  ) {
    return this.sales.changePaymentMode(user.id, bid, billId, body.mode);
  }

  @Get("bills/export/rows")
  exportRows(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Query(new ZodBody(salesFilterSchema)) filter: SalesFilter,
    @Query("cursor") cursor?: string,
  ) {
    return this.sales.exportRows(user.id, bid, filter, cursor);
  }

  @Post("bills/export/pdfs")
  async pdfs(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Body(new ZodBody(pdfBatchSchema)) body: z.infer<typeof pdfBatchSchema>,
    @Res() res: Response,
  ) {
    const zip = await this.sales.pdfBatch(user.id, bid, body.billIds);
    res.status(200).setHeader("Content-Type", "application/zip");
    res.send(Buffer.from(zip));
  }

  @Get("analytics")
  insights(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Query(new ZodBody(salesFilterSchema)) filter: SalesFilter,
  ) {
    return this.analytics.get(user.id, bid, filter);
  }
}
