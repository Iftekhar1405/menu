import {
  Body,
  Controller,
  Get,
  GoneException,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { z } from "zod";
import type { RequestUser } from "../auth/jwt.strategy";
import { CurrentUser, Public } from "../common/decorators";
import { ZodBody } from "../common/zod.pipe";
import { PublicService } from "../public/public.service";
import {
  CurrentTable,
  TableSessionGuard,
  TableSessionService,
  type TableSession,
} from "../tables/table-session";
import { OrdersService } from "./orders.service";

const resolveSchema = z.object({ token: z.string().min(8).max(128) });

const placeSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        variantId: z.string().uuid().nullish(),
        quantity: z.number().int().min(1).max(99),
      }),
    )
    .min(1)
    .max(60),
});

const statusSchema = z.object({
  status: z.enum(["placed", "preparing", "ready", "completed", "cancelled"]),
});

/**
 * Diner-facing ordering.
 *
 * Every route is @Public to the owner guard and guarded instead by
 * TableSessionGuard — a different principal entirely. Nothing here can reach
 * beyond the single table its session names.
 */
@Controller("public")
export class TableOrderController {
  constructor(
    private readonly orders: OrdersService,
    private readonly sessions: TableSessionService,
    private readonly publicMenu: PublicService,
  ) {}

  /** The only unauthenticated route here: trades a printed token for a session. */
  @Public()
  @Post("tables/resolve")
  async resolve(@Body(new ZodBody(resolveSchema)) body: { token: string }) {
    const table = await this.orders.resolveToken(body.token);
    const sessionToken = await this.sessions.mint({
      tableId: table.tableId,
      businessId: table.businessId,
    });
    return {
      sessionToken,
      table: { id: table.tableId, label: table.tableLabel },
      business: { name: table.businessName, publicCode: table.publicCode },
    };
  }

  @Public()
  @UseGuards(TableSessionGuard)
  @Get("table/session")
  session(@CurrentTable() session: TableSession) {
    return this.lookup(session);
  }

  @Public()
  @UseGuards(TableSessionGuard)
  @Get("table/menu")
  async menu(@CurrentTable() session: TableSession) {
    const { business } = await this.lookup(session);
    return this.publicMenu.menuByCode(business.publicCode);
  }

  @Public()
  @UseGuards(TableSessionGuard)
  @Get("table/order")
  currentOrder(@CurrentTable() session: TableSession) {
    return this.orders.currentForTable(session.tableId);
  }

  @Public()
  @UseGuards(TableSessionGuard)
  @Post("table/order")
  async place(
    @CurrentTable() session: TableSession,
    @Body(new ZodBody(placeSchema)) body: z.infer<typeof placeSchema>,
  ) {
    // The function returns the updated order, so no follow-up read is needed.
    return this.orders.placeRound(session.businessId, session.tableId, body.items);
  }

  /**
   * Resolves the session's table for display, and re-checks it is still
   * active. A session minted this morning must stop working if staff have
   * since taken that table out of service.
   */
  private async lookup(session: TableSession) {
    const ctx = await this.orders.tableContext(session.tableId, session.businessId);

    if (!ctx) throw new NotFoundException("That table no longer exists");
    if (!ctx.isActive) {
      throw new GoneException("This table is no longer taking orders");
    }

    return {
      table: { id: ctx.tableId, label: ctx.tableLabel },
      business: {
        name: ctx.businessName,
        publicCode: ctx.publicCode,
        currency: ctx.currency,
      },
    };
  }
}

/** Staff-facing order board. */
@Controller("businesses/:bid/orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Query("scope") scope: "open" | "today" = "open",
  ) {
    return this.orders.listForBusiness(
      user.id,
      bid,
      scope === "today" ? "today" : "open",
    );
  }

  @Patch(":id/status")
  setStatus(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("id") id: string,
    @Body(new ZodBody(statusSchema)) body: { status: OrderStatus },
  ) {
    return this.orders.setStatus(user.id, bid, id, body.status);
  }
}
