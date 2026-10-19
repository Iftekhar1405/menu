import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import {
  stationCreateSchema,
  stationOutputSchema,
  stationRenameSchema,
  type StationCreateInput,
  type StationOutputInput,
  type StationRenameInput,
} from "@menu/shared";
import { CurrentUser } from "../common/decorators";
import { ZodBody } from "../common/zod.pipe";
import type { RequestUser } from "../auth/jwt.strategy";
import { ReceiptsService } from "./receipts.service";
import { StationsService } from "./stations.service";

/**
 * Owner and kitchen throughout, except revoke (owner) and a bill output
 * (owner, enforced in the service and again by a trigger). A station is a
 * machine in a shop, and the person standing next to it is usually not the
 * owner.
 */
@Controller("businesses/:bid/stations")
export class PrintingController {
  constructor(
    private readonly stations: StationsService,
    private readonly receipts: ReceiptsService,
  ) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Param("bid") bid: string) {
    return this.stations.list(user.id, bid);
  }

  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Body(new ZodBody(stationCreateSchema)) body: StationCreateInput,
  ) {
    return this.stations.create(user.id, bid, body.name);
  }

  @Patch(":sid")
  rename(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("sid") sid: string,
    @Body(new ZodBody(stationRenameSchema)) body: StationRenameInput,
  ) {
    return this.stations.rename(user.id, bid, sid, body.name);
  }

  @Delete(":sid")
  @HttpCode(204)
  async revoke(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("sid") sid: string,
  ) {
    await this.stations.revoke(user.id, bid, sid);
  }

  @Post(":sid/outputs")
  attach(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("sid") sid: string,
    @Body(new ZodBody(stationOutputSchema)) body: StationOutputInput,
  ) {
    return this.stations.attachOutput(user.id, bid, sid, body);
  }

  @Delete(":sid/outputs/:job")
  @HttpCode(204)
  async detach(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("sid") sid: string,
    @Param("job") job: string,
  ) {
    await this.stations.detachOutput(user.id, bid, sid, job);
  }

  /**
   * Polled every ten seconds, and again whenever the Realtime ping lands.
   * The ping is an optimisation over polling and is allowed to be lost.
   */
  @Get(":sid/pending")
  pending(@CurrentUser() user: RequestUser, @Param("bid") bid: string, @Param("sid") sid: string) {
    return this.receipts.pending(user.id, bid, sid);
  }
}
