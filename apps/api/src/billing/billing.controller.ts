import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import type { RequestUser } from "../auth/jwt.strategy";
import { CurrentUser, Public } from "../common/decorators";
import { ZodBody } from "../common/zod.pipe";
import {
  CurrentTable,
  TableSessionGuard,
  type TableSession,
} from "../tables/table-session";
import { MediaService } from "../media/media.service";
import { BillingService, type Bill } from "./billing.service";
import { buildBillPdf } from "./bill.pdf";
import { buildReceiptPdf } from "./receipt.pdf";

/**
 * Two documents from one bill.
 *
 * `bill` is an A5 page — the one a diner emails themselves or hands to an
 * accounts department. `receipt` is the 80mm till slip for the counter
 * printer. They are different artefacts for different moments, and both
 * carry the business's own logo.
 */
type DocFormat = "bill" | "receipt";

function parseFormat(raw: string | undefined): DocFormat {
  return raw === "receipt" ? "receipt" : "bill";
}

const taxSchema = z.object({
  taxEnabled: z.boolean().optional(),
  taxLabel: z.string().trim().min(1).max(20).optional(),
  defaultTaxRate: z.number().min(0).max(100).optional(),
  pricesIncludeTax: z.boolean().optional(),
  gstin: z.string().trim().max(20).nullish(),
  serviceChargeEnabled: z.boolean().optional(),
  serviceChargeRate: z.number().min(0).max(100).optional(),
  receiptFooter: z.string().trim().max(300).nullish(),
});

const ratingSchema = z.object({
  stars: z.number().int().min(1).max(5),
  promptId: z.string().uuid().nullish(),
  privateFeedback: z.string().trim().max(2000).nullish(),
});

/** Staff-facing billing. No time window: this is the owner's own record. */
@Controller("businesses/:bid")
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly media: MediaService,
  ) {}

  private async render(bill: Bill, format: DocFormat): Promise<Buffer> {
    const logo = await this.media.imageBytes(bill.business.logoPath);
    return format === "receipt"
      ? buildReceiptPdf(bill, logo)
      : buildBillPdf(bill, logo);
  }

  @Post("orders/:id/bill")
  generate(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("id") id: string,
  ) {
    return this.billing.generate(user.id, bid, id);
  }

  @Get("orders/:id/bill")
  forOrder(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("id") id: string,
  ) {
    return this.billing.forOrder(user.id, bid, id);
  }

  @Get("orders/:id/bill/pdf")
  async pdf(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("id") id: string,
    @Res() res: Response,
    @Query("format") format?: string,
  ) {
    const kind = parseFormat(format);
    const bill = await this.billing.forOrder(user.id, bid, id);
    const pdf = await this.render(bill, kind);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${kind}-${bill.billNumber}.pdf"`,
    );
    res.send(pdf);
  }

  @Get("bills")
  list(@CurrentUser() user: RequestUser, @Param("bid") bid: string) {
    return this.billing.listBills(user.id, bid);
  }

  @Get("tax")
  getTax(@CurrentUser() user: RequestUser, @Param("bid") bid: string) {
    return this.billing.getTaxConfig(user.id, bid);
  }

  @Patch("tax")
  setTax(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Body(new ZodBody(taxSchema)) body: z.infer<typeof taxSchema>,
  ) {
    return this.billing.setTaxConfig(user.id, bid, {
      ...body,
      gstin: body.gstin ?? null,
      receiptFooter: body.receiptFooter ?? null,
    });
  }

  @Get("ratings")
  ratings(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Query("days") days = "30",
  ) {
    return this.billing.listRatings(user.id, bid, Math.min(Number(days) || 30, 365));
  }
}

/**
 * Diner-facing bill and rating.
 *
 * None of these take a bill or order id. A session reaches exactly one bill —
 * its own table's most recent, inside the window — so there is nothing here to
 * enumerate, and the windows themselves are SQL predicates rather than checks
 * this controller has to remember.
 */
@Controller("public/table")
export class TableBillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly media: MediaService,
  ) {}

  @Public()
  @UseGuards(TableSessionGuard)
  @Get("bill")
  async bill(@CurrentTable() session: TableSession) {
    return this.billing.billForTable(session.tableId);
  }

  /** The diner gets both documents, same as the owner. */
  @Public()
  @UseGuards(TableSessionGuard)
  @Get("bill/pdf")
  async billPdf(
    @CurrentTable() session: TableSession,
    @Res() res: Response,
    @Query("format") format?: string,
  ) {
    const kind = parseFormat(format);
    const bill = await this.billing.billForTable(session.tableId);
    if (!bill) {
      throw new NotFoundException("That bill is no longer available to download");
    }

    const logo = await this.media.imageBytes(bill.business.logoPath);
    const pdf =
      kind === "receipt" ? await buildReceiptPdf(bill, logo) : await buildBillPdf(bill, logo);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${kind}-${bill.billNumber}.pdf"`,
    );
    res.send(pdf);
  }

  /** A service charge cannot be mandatory, so the diner can take it off. */
  @Public()
  @UseGuards(TableSessionGuard)
  @Post("bill/service-charge/remove")
  removeServiceCharge(@CurrentTable() session: TableSession) {
    return this.billing.removeServiceCharge(session.tableId);
  }

  @Public()
  @UseGuards(TableSessionGuard)
  @Get("rating")
  ratable(@CurrentTable() session: TableSession) {
    return this.billing.ratableOrder(session.tableId);
  }

  @Public()
  @UseGuards(TableSessionGuard)
  @Get("rating/prompts")
  async prompts(
    @CurrentTable() session: TableSession,
    @Query("stars") stars = "5",
  ) {
    const band = bandFor(Number(stars) || 5);
    return this.billing.reviewPrompts(session.businessId, band);
  }

  @Public()
  @UseGuards(TableSessionGuard)
  @Post("rating")
  submit(
    @CurrentTable() session: TableSession,
    @Body(new ZodBody(ratingSchema)) body: z.infer<typeof ratingSchema>,
  ) {
    return this.billing.submitRating(
      session.tableId,
      body.stars,
      body.promptId ?? null,
      body.privateFeedback ?? null,
    );
  }
}

/**
 * Bands exist to pick suggested wording, not to decide who is shown the Google
 * link. Every band gets the same routes offered to it — steering unhappy
 * diners away from Google is review gating, which violates Google's policies.
 */
function bandFor(stars: number): "low" | "good" | "great" {
  if (stars >= 5) return "great";
  if (stars === 4) return "good";
  return "low";
}
