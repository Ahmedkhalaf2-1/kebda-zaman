import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CartService } from '../cart/cart.service';
import { PricingService } from '../pricing/pricing.service';
import { SettingsService } from '../settings/settings.service';
import { DeliveryPricingService } from '../delivery-pricing/delivery-pricing.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { AdminNotificationsService } from '../admin-notifications/admin-notifications.service';

/**
 * Admin "wipe orders" feature — clears test/demo order data before a real
 * launch. Deliberately overrides this codebase's usual "Order is never
 * hard-deleted" invariant, so the production guard is the load-bearing
 * behavior under test here, not just the happy path.
 */
describe('OrdersService — admin order reset', () => {
  let prisma: {
    order: { count: jest.Mock; deleteMany: jest.Mock };
    orderItem: { count: jest.Mock };
    payment: { count: jest.Mock };
    itemReview: { count: jest.Mock };
    orderFeedback: { count: jest.Mock };
  };
  let config: { get: jest.Mock };
  let service: OrdersService;

  beforeEach(() => {
    prisma = {
      order: { count: jest.fn(), deleteMany: jest.fn() },
      orderItem: { count: jest.fn() },
      payment: { count: jest.fn() },
      itemReview: { count: jest.fn() },
      orderFeedback: { count: jest.fn() },
    };
    config = { get: jest.fn().mockReturnValue('development') };
    service = new OrdersService(
      prisma as unknown as PrismaService,
      {} as CartService,
      {} as PricingService,
      {} as SettingsService,
      {} as DeliveryPricingService,
      {} as NotificationsService,
      {} as PaymentsService,
      {} as LoyaltyService,
      {} as AdminNotificationsService,
      config as unknown as ConfigService,
    );
  });

  describe('adminOrdersResetPreview', () => {
    it('returns counts without deleting anything', async () => {
      prisma.order.count.mockResolvedValue(342);
      prisma.orderItem.count.mockResolvedValue(900);
      prisma.payment.count.mockResolvedValue(340);
      prisma.itemReview.count.mockResolvedValue(88);
      prisma.orderFeedback.count.mockResolvedValue(70);

      const preview = await service.adminOrdersResetPreview();

      expect(preview).toEqual({
        orders: 342,
        items: 900,
        payments: 340,
        reviews: 88,
        feedback: 70,
      });
      expect(prisma.order.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('adminResetOrders', () => {
    it('deletes every order and returns the pre-deletion counts', async () => {
      prisma.order.count.mockResolvedValue(5);
      prisma.orderItem.count.mockResolvedValue(12);
      prisma.payment.count.mockResolvedValue(5);
      prisma.itemReview.count.mockResolvedValue(2);
      prisma.orderFeedback.count.mockResolvedValue(1);
      prisma.order.deleteMany.mockResolvedValue({ count: 5 });

      const result = await service.adminResetOrders();

      expect(prisma.order.deleteMany).toHaveBeenCalledWith({});
      expect(result.orders).toBe(5);
    });

    it('refuses to run in production and never touches the database', async () => {
      config.get.mockReturnValue('production');

      await expect(service.adminResetOrders()).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.order.deleteMany).not.toHaveBeenCalled();
      expect(prisma.order.count).not.toHaveBeenCalled();
    });
  });
});
