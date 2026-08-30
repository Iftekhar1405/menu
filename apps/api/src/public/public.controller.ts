import { Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { Public } from "../common/decorators";
import { PublicService } from "./public.service";

@Controller("public")
export class PublicController {
  constructor(private readonly service: PublicService) {}

  @Public()
  @Get("menus/:code")
  menu(@Param("code") code: string) {
    return this.service.menuByCode(code);
  }

  @Public()
  @Get("slugs/:slug")
  slug(@Param("slug") slug: string) {
    return this.service.codeForSlug(slug).then((publicCode) => ({ publicCode }));
  }

  @Public()
  @HttpCode(204)
  @Post("menus/:code/view")
  async view(@Param("code") code: string) {
    await this.service.recordView(code);
  }
}
