import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module";
import { BusinessesController } from "./businesses/businesses.controller";
import { BusinessesService } from "./businesses/businesses.service";
import { JwtAuthGuard, RolesGuard } from "./common/guards";
import { HealthController } from "./health/health.controller";
import { HealthService } from "./health/health.service";
import { TenantInterceptor } from "./common/tenant.interceptor";
import { MediaController } from "./media/media.controller";
import { MediaService } from "./media/media.service";
import { MenuController } from "./menu/menu.controller";
import { MenuService } from "./menu/menu.service";
// import { NotificationsModule } from "./notifications/notifications.module";
import { PrismaModule } from "./prisma/prisma.module";
import { PublicController } from "./public/public.controller";
import { PublicService } from "./public/public.service";
import { RevalidateClient } from "./public/revalidate.client";
import { QrController } from "./qr/qr.controller";
import { QrService } from "./qr/qr.service";
import { OrdersController, TableOrderController } from "./orders/orders.controller";
import { OrdersService } from "./orders/orders.service";
import { TablesController } from "./tables/tables.controller";
import { TablesService } from "./tables/tables.service";
import { TableSessionGuard, TableSessionService } from "./tables/table-session";
import { JwtModule } from "@nestjs/jwt";
import { BillingController, TableBillingController } from "./billing/billing.controller";
import { BillingService } from "./billing/billing.service";
import { AdminMerchController, MerchController } from "./merch/merch.controller";
import { MerchService } from "./merch/merch.service";

@Module({
  imports: [PrismaModule, 
    // NotificationsModule, 
    AuthModule, JwtModule.register({})],
  controllers: [
    HealthController,
    BusinessesController,
    MenuController,
    MediaController,
    PublicController,
    QrController,
    TablesController,
    OrdersController,
    TableOrderController,
    BillingController,
    TableBillingController,
    MerchController,
    AdminMerchController,
  ],
  providers: [
    HealthService,
    BusinessesService,
    MenuService,
    MediaService,
    PublicService,
    RevalidateClient,
    QrService,
    TablesService,
    OrdersService,
    TableSessionService,
    TableSessionGuard,
    BillingService,
    MerchService,
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
