import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { businessUpdateSchema, type BusinessUpdateInput } from "@menu/shared";
import { CurrentUser } from "../common/decorators";
import { ZodBody } from "../common/zod.pipe";
import type { RequestUser } from "../auth/jwt.strategy";
import { MediaService } from "../media/media.service";
import { BusinessesService } from "./businesses.service";

@Controller("businesses")
export class BusinessesController {
  constructor(
    private readonly businesses: BusinessesService,
    private readonly media: MediaService,
  ) {}

  @Get("mine")
  listMine(@CurrentUser() user: RequestUser) {
    return this.businesses.listMine(user.id);
  }

  @Get(":id/summary")
  summary(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    return this.businesses.summary(user.id, id);
  }

  @Patch(":id")
  update(
    @CurrentUser() user: RequestUser,
    @Param("id") id: string,
    @Body(new ZodBody(businessUpdateSchema)) patch: BusinessUpdateInput,
  ) {
    return this.businesses.update(user.id, id, patch);
  }

  /**
   * Logo bytes go straight from the browser to storage. The API only hands
   * out a short-lived URL scoped to a path it chose itself, so a client
   * cannot write outside its own business folder.
   */
  @Post(":id/logo/upload-url")
  async logoUploadUrl(@CurrentUser() user: RequestUser, @Param("id") id: string) {
    await this.businesses.assertOwns(user.id, id);
    return this.media.createUploadUrl(id, "logo");
  }
}
