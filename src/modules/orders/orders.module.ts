import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { PricingModule } from '../pricing/pricing.module';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { AdminNotificationsModule } from '../admin-notifications/admin-notifications.module';
import { DeliveryPricingModule } from '../delivery-pricing/delivery-pricing.module';
import { OrdersController } from './orders.controller';
import { CheckoutController } from './checkout.controller';
import { AdminOrdersController } from './admin-orders.controller';
import { KitchenOrdersController } from './kitchen-orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [
    CartModule,
    PricingModule,
    SettingsModule,
    NotificationsModule,
    PaymentsModule,
    LoyaltyModule,
    AdminNotificationsModule,
    DeliveryPricingModule,
  ],
  controllers: [
    OrdersController,
    CheckoutController,
    AdminOrdersController,
    KitchenOrdersController,
  ],
  providers: [OrdersService],
})
export class OrdersModule {}
