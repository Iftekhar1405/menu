import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module";
import { BusinessesController } from "./businesses/businesses.controller";
import { BusinessesService } from "./businesses/businesses.service";
import { JwtAuthGuard, RolesGuard } from "./common/guards";
import { TenantInterceptor } from "./common/tenant.interceptor";
import { MediaController } from "./media/media.controller";
import { MediaService } from "./media/media.service";
import { MenuController } from "./menu/menu.controller";
import { MenuService } from "./menu/menu.service";
import { NotificationsModule } from "./notifications/notifications.module";
import { PrismaModule } from "./prisma/prisma.module";
import { PublicController } from "./public/public.controller";
import { PublicService } from "./public/public.service";
import { RevalidateClient } from "./public/revalidate.client";
import { QrController } from "./qr/qr.controller";
import { QrService } from "./qr/qr.service";

@Module({
  imports: [PrismaModule, NotificationsModule, AuthModule],
  controllers: [
    BusinessesController,
    MenuController,
    MediaController,
    PublicController,
    QrController,
  ],
  providers: [
    BusinessesService,
    MenuService,
    MediaService,
    PublicService,
    RevalidateClient,
    QrService,
    // Authenticated by default: a new controller is protected unless it
    // explicitly opts out with @Public.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // Binds every authenticated request to its tenant transaction, so RLS
    // applies without any service having to remember to set it up.
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
  ],
})
export class AppModule {}
