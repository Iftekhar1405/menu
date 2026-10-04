import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import {
  staffCreateSchema, staffStatusSchema,
  type StaffCreateInput, type StaffStatusInput,
} from "@menu/shared";
import { CurrentUser } from "../common/decorators";
import { ZodBody } from "../common/zod.pipe";
import type { RequestUser } from "../auth/jwt.strategy";
import { StaffService } from "./staff.service";

/** Owner-only throughout: every method goes through assertOwns. */
@Controller("businesses/:bid/staff")
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Param("bid") bid: string) {
    return this.staff.list(user.id, bid);
  }

  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Body(new ZodBody(staffCreateSchema)) body: StaffCreateInput,
  ) {
    return this.staff.create(user.id, bid, body);
  }

  @Patch(":staffId")
  setStatus(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("staffId") staffId: string,
    @Body(new ZodBody(staffStatusSchema)) body: StaffStatusInput,
  ) {
    return this.staff.setStatus(user.id, bid, staffId, body.status);
  }

  @Post(":staffId/reset-pin")
  @HttpCode(200)
  resetPin(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("staffId") staffId: string,
  ) {
    return this.staff.resetPin(user.id, bid, staffId);
  }

  @Delete(":staffId")
  @HttpCode(204)
  async remove(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("staffId") staffId: string,
  ) {
    await this.staff.remove(user.id, bid, staffId);
  }
}
