import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
} from "@nestjs/common";
import {
  categorySchema,
  menuItemSchema,
  reorderSchema,
  type CategoryInput,
  type MenuItemInput,
} from "@menu/shared";
import { z } from "zod";
import type { RequestUser } from "../auth/jwt.strategy";
import { CurrentUser } from "../common/decorators";
import { ZodBody } from "../common/zod.pipe";
import { MenuService } from "./menu.service";

const itemReorderSchema = reorderSchema.extend({ categoryId: z.string().uuid() });
const availabilitySchema = z.object({ isAvailable: z.boolean() });
const categoryPatchSchema = categorySchema.partial();

@Controller("businesses/:bid")
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  @Get("menu")
  fullMenu(@CurrentUser() user: RequestUser, @Param("bid") bid: string) {
    return this.menu.fullMenu(user.id, bid);
  }

  // ── Categories ────────────────────────────────────────────────────────────

  @Post("categories")
  createCategory(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Body(new ZodBody(categorySchema)) body: CategoryInput,
  ) {
    return this.menu.createCategory(user.id, bid, body);
  }

  @Patch("categories/reorder")
  @HttpCode(204)
  async reorderCategories(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Body(new ZodBody(reorderSchema)) body: { ids: string[] },
  ) {
    await this.menu.reorderCategories(user.id, bid, body.ids);
  }

  @Patch("categories/:id")
  updateCategory(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("id") id: string,
    @Body(new ZodBody(categoryPatchSchema)) body: Partial<CategoryInput>,
  ) {
    return this.menu.updateCategory(user.id, bid, id, body);
  }

  @Delete("categories/:id")
  @HttpCode(204)
  async deleteCategory(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("id") id: string,
  ) {
    await this.menu.deleteCategory(user.id, bid, id);
  }

  // ── Items ─────────────────────────────────────────────────────────────────

  @Post("items")
  createItem(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Body(new ZodBody(menuItemSchema)) body: MenuItemInput,
  ) {
    return this.menu.createItem(user.id, bid, body);
  }

  // Declared before :id so "reorder" is not swallowed as an item id.
  @Patch("items/reorder")
  @HttpCode(204)
  async reorderItems(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Body(new ZodBody(itemReorderSchema)) body: z.infer<typeof itemReorderSchema>,
  ) {
    await this.menu.reorderItems(user.id, bid, body.categoryId, body.ids);
  }

  @Put("items/:id")
  updateItem(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("id") id: string,
    @Body(new ZodBody(menuItemSchema)) body: MenuItemInput,
  ) {
    return this.menu.updateItem(user.id, bid, id, body);
  }

  @Patch("items/:id/availability")
  setAvailability(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("id") id: string,
    @Body(new ZodBody(availabilitySchema)) body: { isAvailable: boolean },
  ) {
    return this.menu.setItemAvailability(user.id, bid, id, body.isAvailable);
  }

  @Delete("items/:id")
  @HttpCode(204)
  async deleteItem(
    @CurrentUser() user: RequestUser,
    @Param("bid") bid: string,
    @Param("id") id: string,
  ) {
    await this.menu.deleteItem(user.id, bid, id);
  }
}
