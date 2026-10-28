import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserAwareThrottlerGuard } from './common/throttler.guard';
import { PrismaModule } from './prisma/prisma.service';
import { SettingsModule } from './settings/settings.module';
import { AuditModule } from './audit/audit.service';
import { JobsModule } from './jobs/jobs.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AuthModule } from './auth/auth.module';
import { StorageModule } from './storage/storage.service';
import { GeoModule } from './geo/geo.service';
import { RealtimeModule } from './realtime/realtime.gateway';
import { HealthController } from './health/health.controller';
import { CustomerController } from './customers/customer.controller';
import { DriverController } from './drivers/driver.controller';
import { WebhooksController } from './payments/webhooks.controller';
import {
  AdminAccessController,
  AdminCatalogueController,
  AdminCustomersController,
  AdminDashboardController,
  AdminDisputesController,
  AdminDriversController,
  AdminMoneyController,
  AdminOrdersController,
  AdminReportsController,
  AdminSettingsController,
  AdminTemplatesController,
  AdminTrucksController,
} from './admin/admin.controllers';
import { LedgerService } from './wallet/ledger.service';
import { WalletService } from './wallet/wallet.service';
import { SettlementService } from './orders/settlement.service';
import { OrderTransitionsService } from './orders/transitions.service';
import { DispatchService } from './orders/dispatch.service';
import { OrdersService } from './orders/orders.service';
import { PaymentProvidersRegistry } from './payments/providers.registry';
import { RefundsService } from './payments/refunds.service';
import { PaymentsService } from './payments/payments.service';
import { DriversService } from './drivers/drivers.service';
import { CatalogueService } from './catalogue/catalogue.service';
import { CustomersService } from './customers/customers.service';
import { DisputesService } from './disputes/disputes.service';
import { RatingsService } from './disputes/ratings.service';
import { ReportsService } from './reports/reports.service';
import { AdminUsersService } from './admin/admin-users.service';
import { SweeperService } from './jobs/sweeper.service';
import { IdempotencyInterceptor } from './common/idempotency';

/**
 * Domain services live in one module: they form a small, acyclic graph
 * (ledger → settlement/refunds → transitions → dispatch/orders/payments → drivers/disputes),
 * and keeping them together avoids forwardRef plumbing.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    PrismaModule,
    SettingsModule,
    AuditModule,
    JobsModule,
    NotificationsModule,
    AuthModule,
    StorageModule,
    GeoModule,
    RealtimeModule,
  ],
  controllers: [
    HealthController,
    CustomerController,
    DriverController,
    WebhooksController,
    AdminDashboardController,
    AdminOrdersController,
    AdminCustomersController,
    AdminDriversController,
    AdminTrucksController,
    AdminCatalogueController,
    AdminSettingsController,
    AdminMoneyController,
    AdminDisputesController,
    AdminTemplatesController,
    AdminAccessController,
    AdminReportsController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: UserAwareThrottlerGuard },
    IdempotencyInterceptor,
    LedgerService,
    WalletService,
    SettlementService,
    PaymentProvidersRegistry,
    RefundsService,
    OrderTransitionsService,
    DispatchService,
    OrdersService,
    PaymentsService,
    DriversService,
    CatalogueService,
    CustomersService,
    DisputesService,
    RatingsService,
    ReportsService,
    AdminUsersService,
    SweeperService,
  ],
})
export class AppModule {}
