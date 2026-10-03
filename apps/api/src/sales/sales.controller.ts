import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import { markPaidSchema, salesFilterSchema, type MarkPaidInput, type SalesFilter } from "@menu/shared";
import type { RequestUser } from "../auth/jwt.strategy";
import { CurrentUser } from "../common/decorators";
import { ZodBody } from "../common/zod.pipe";
import { SalesService } from "./sales.service";

/**
 * The owner's sales record. Authenticated by the global guard; every handler
 * goes through assertOwns in the service, and every query runs on the tenant
 * transaction, so RLS is the second wall.
 */
@Controller("businesses/:bid")
export class SalesController {
  constructor(private readonly sales: SalesService) {}

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
}
