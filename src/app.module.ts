import { randomUUID } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule, seconds } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import configuration from './config/configuration';
import { validationSchema } from './config/validation.schema';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { SettingsModule } from './modules/settings/settings.module';
import { CartModule } from './modules/cart/cart.module';
import { PromosModule } from './modules/promos/promos.module';
import { OrdersModule } from './modules/orders/orders.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { DevicesModule } from './modules/devices/devices.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { AddressesModule } from './modules/addresses/addresses.module';
import { FavoritesModule } from './modules/favorites/favorites.module';
import { LoyaltyModule } from './modules/loyalty/loyalty.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { AdminNotificationsModule } from './modules/admin-notifications/admin-notifications.module';
import { StaffModule } from './modules/staff/staff.module';
import { CustomersModule } from './modules/customers/customers.module';
import { ReportsModule } from './modules/reports/reports.module';
import { JwtAccessGuard } from './common/guards/jwt-access.guard';
import { RolesGuard } from './common/guards/roles.guard';

@Module({
  imports: [
    // Typed + validated configuration. Fails fast on a missing/invalid env var.
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validationSchema,
      validationOptions: { abortEarly: false },
    }),

    // Structured JSON logging with per-request correlation ids.
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isProduction = config.get<string>('nodeEnv') === 'production';
        return {
          pinoHttp: {
            level: config.get<string>('logLevel') ?? 'info',
            // Correlation id: reuse an inbound x-request-id or generate one.
            genReqId: (req: IncomingMessage, res) => {
              const existing = req.headers['x-request-id'];
              const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
              res.setHeader('x-request-id', id);
              return id;
            },
            autoLogging: true,
            // Pretty logs in dev, raw JSON in production.
            transport: isProduction
              ? undefined
              : {
                  target: 'pino-pretty',
                  options: { singleLine: true, translateTime: 'SYS:standard' },
                },
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.password',
                'req.body.refreshToken',
              ],
              remove: true,
            },
          },
        };
      },
    }),

    // Access-token signing, available app-wide (used by TokenService and JwtAccessGuard).
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),
        signOptions: {
          expiresIn: config.get<string>('jwt.accessTtl') as JwtSignOptions['expiresIn'],
        },
      }),
    }),

    // Global request rate limiting (plan §5.6). In-memory store; single instance.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: seconds(config.get<number>('throttle.ttlSeconds') ?? 60),
          limit: config.get<number>('throttle.limit') ?? 100,
        },
      ],
    }),

    // Backs CampaignsSchedulerService's @Interval poller (plan §9.5) — no Redis.
    ScheduleModule.forRoot(),

    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    CatalogModule,
    PricingModule,
    SettingsModule,
    CartModule,
    PromosModule,
    OrdersModule,
    NotificationsModule,
    DevicesModule,
    PaymentsModule,
    AddressesModule,
    FavoritesModule,
    LoyaltyModule,
    UploadsModule,
    AdminNotificationsModule,
    StaffModule,
    CustomersModule,
    ReportsModule,
  ],
  providers: [
    // Order matters: rate limiting first, then authenticate, then authorize.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAccessGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
