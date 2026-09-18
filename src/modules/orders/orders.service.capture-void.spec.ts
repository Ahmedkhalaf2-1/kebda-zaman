import { ConflictException } from '@nestjs/common';
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
 * Verifies the core business rule (moyasar-integration-plan memory): a CARD
 * order is never marked CONFIRMED before its payment is actually captured,
 * and a failed capture must never leave the order transitioned anyway.
 */
describe('OrdersService.updateOrderStatus — capture/void gating', () => {
  function orderFixture(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'order-1',
      status: 'PENDING',
      deliveryMethod: 'PICKUP',
      paymentMethod: 'CARD',
      ...overrides,
    };
  }

  let prisma: {
    order: { findUnique: jest.Mock; updateMany: jest.Mock };
    orderStatusHistory: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let paymentsService: {
    captureAuthorizedPayment: jest.Mock;
    voidAuthorizedPayment: jest.Mock;
    compensateOrphanedCapture: jest.Mock;
    settleCashOnDelivery: jest.Mock;
  };
  let notificationsService: { sendOrderStatusNotification: jest.Mock };
  let loyaltyService: { earnForOrder: jest.Mock };
  let service: OrdersService;
  let txOrderUpdateMany: jest.Mock;

  beforeEach(() => {
    txOrderUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const reloadedOrder = orderFixture({
      status: 'CONFIRMED',
      user: {
        id: 'user-1',
        fullName: 'Test User',
        email: 'test@example.com',
        phone: null,
        avatarUrl: null,
        role: 'CUSTOMER',
        isGuest: false,
        locale: 'en',
        createdAt: new Date(),
      },
      items: [],
      payments: [],
      deliveryAddressJson: { type: 'PICKUP' },
      subtotal: { toNumber: () => 50 },
      deliveryFee: { toNumber: () => 0 },
      tax: { toNumber: () => 0 },
      discount: { toNumber: () => 0 },
      totalAmount: { toNumber: () => 50 },
      createdAt: new Date(),
      estimatedDeliveryTime: null,
      deliveryZoneId: null,
      deliveryDistanceMeters: null,
      deliveryDurationSeconds: null,
      deliveryTierId: null,
    });
    const tx = {
      order: {
        updateMany: txOrderUpdateMany,
        findUnique: jest.fn().mockResolvedValue(reloadedOrder),
      },
      orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      order: { findUnique: jest.fn(), updateMany: jest.fn() },
      orderStatusHistory: { create: jest.fn() },
      $transaction: jest.fn((callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    };
    paymentsService = {
      captureAuthorizedPayment: jest.fn().mockResolvedValue(undefined),
      voidAuthorizedPayment: jest.fn().mockResolvedValue(undefined),
      compensateOrphanedCapture: jest.fn().mockResolvedValue(undefined),
      settleCashOnDelivery: jest.fn().mockResolvedValue(undefined),
    };
    notificationsService = { sendOrderStatusNotification: jest.fn().mockResolvedValue(undefined) };
    loyaltyService = { earnForOrder: jest.fn().mockResolvedValue(undefined) };

    service = new OrdersService(
      prisma as unknown as PrismaService,
      {} as CartService,
      {} as PricingService,
      {} as SettingsService,
      {} as DeliveryPricingService,
      notificationsService as unknown as NotificationsService,
      paymentsService as unknown as PaymentsService,
      loyaltyService as unknown as LoyaltyService,
      {} as AdminNotificationsService,
      {} as ConfigService,
    );
  });

  it('captures the payment BEFORE committing PENDING->CONFIRMED for a CARD order', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFixture());

    await service.updateOrderStatus('order-1', 'CONFIRMED', 'admin-1');

    const captureOrder = paymentsService.captureAuthorizedPayment.mock.invocationCallOrder[0];
    const claimOrder = txOrderUpdateMany.mock.invocationCallOrder[0];
    expect(captureOrder).toBeLessThan(claimOrder);
  });

  it('never commits the CONFIRMED transition when capture throws', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFixture());
    paymentsService.captureAuthorizedPayment.mockRejectedValue(
      new ConflictException({ message: 'not authorized', code: 'PAYMENT_NOT_AUTHORIZED' }),
    );

    await expect(
      service.updateOrderStatus('order-1', 'CONFIRMED', 'admin-1'),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_NOT_AUTHORIZED' },
    });
    expect(txOrderUpdateMany).not.toHaveBeenCalled();
  });

  it('voids the payment BEFORE committing PENDING->CANCELLED for a CARD order', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFixture());

    await service.updateOrderStatus('order-1', 'CANCELLED', 'admin-1');

    const voidOrder = paymentsService.voidAuthorizedPayment.mock.invocationCallOrder[0];
    const claimOrder = txOrderUpdateMany.mock.invocationCallOrder[0];
    expect(voidOrder).toBeLessThan(claimOrder);
  });

  it('never calls capture/void for a CASH order', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFixture({ paymentMethod: 'CASH' }));

    await service.updateOrderStatus('order-1', 'CONFIRMED', 'admin-1');

    expect(paymentsService.captureAuthorizedPayment).not.toHaveBeenCalled();
    expect(paymentsService.voidAuthorizedPayment).not.toHaveBeenCalled();
  });

  it('runs a compensating void when capture succeeds but the order-transition claim then loses a concurrency race', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFixture());
    txOrderUpdateMany.mockResolvedValue({ count: 0 }); // another admin already changed it

    await expect(
      service.updateOrderStatus('order-1', 'CONFIRMED', 'admin-1'),
    ).rejects.toMatchObject({
      response: { code: 'ORDER_STATUS_CHANGED' },
    });
    expect(paymentsService.compensateOrphanedCapture).toHaveBeenCalledWith('order-1');
  });

  it('does not compensate when the losing race is for a CANCELLED (void) transition', async () => {
    prisma.order.findUnique.mockResolvedValue(orderFixture());
    txOrderUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.updateOrderStatus('order-1', 'CANCELLED', 'admin-1'),
    ).rejects.toMatchObject({
      response: { code: 'ORDER_STATUS_CHANGED' },
    });
    expect(paymentsService.compensateOrphanedCapture).not.toHaveBeenCalled();
  });
});
