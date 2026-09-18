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
 * Manual Kitchen Preparation Time / ETA feature — the hand-off refresh:
 * once an order leaves kitchen prep, the manual-prep-time-derived ETA is no
 * longer the relevant number, so `updateOrderStatus` folds a fresh
 * `estimatedDeliveryTime` into the same optimistic-concurrency write for two
 * specific transitions only. Uses a mocked PrismaService (no DB) and fake
 * time, mirroring orders.service.capture-void.spec.ts's established pattern
 * — deliberately does NOT touch payment/loyalty/transition-map behavior,
 * which stays covered by that file.
 */
describe('OrdersService.updateOrderStatus — ETA refresh on hand-off', () => {
  const NOW = new Date('2026-01-01T12:00:00.000Z');

  function orderFixture(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'order-1',
      status: 'PREPARING',
      deliveryMethod: 'DELIVERY',
      paymentMethod: 'CASH',
      deliveryDurationSeconds: 900,
      ...overrides,
    };
  }

  function reloadedOrderFixture(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      ...orderFixture(),
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
      deliveryTierId: null,
      ...overrides,
    };
  }

  let prisma: {
    order: { findUnique: jest.Mock; updateMany: jest.Mock };
    orderStatusHistory: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let txOrderUpdateMany: jest.Mock;
  let service: OrdersService;

  function build(existingOrder: Record<string, unknown>, reloaded: Record<string, unknown>) {
    txOrderUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      order: {
        updateMany: txOrderUpdateMany,
        findUnique: jest.fn().mockResolvedValue(reloaded),
      },
      orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      order: { findUnique: jest.fn().mockResolvedValue(existingOrder), updateMany: jest.fn() },
      orderStatusHistory: { create: jest.fn() },
      $transaction: jest.fn((callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    };

    service = new OrdersService(
      prisma as unknown as PrismaService,
      {} as CartService,
      {} as PricingService,
      {} as SettingsService,
      {} as DeliveryPricingService,
      {
        sendOrderStatusNotification: jest.fn().mockResolvedValue(undefined),
      } as unknown as NotificationsService,
      {
        captureAuthorizedPayment: jest.fn(),
        voidAuthorizedPayment: jest.fn(),
        compensateOrphanedCapture: jest.fn(),
        settleCashOnDelivery: jest.fn().mockResolvedValue(undefined),
      } as unknown as PaymentsService,
      { earnForOrder: jest.fn().mockResolvedValue(undefined) } as unknown as LoyaltyService,
      {} as AdminNotificationsService,
    );
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('OUT_FOR_DELIVERY: refreshes ETA to transition time + deliveryDurationSeconds', async () => {
    const existing = orderFixture({
      status: 'PREPARING',
      deliveryMethod: 'DELIVERY',
      deliveryDurationSeconds: 900,
    });
    build(existing, reloadedOrderFixture({ status: 'OUT_FOR_DELIVERY' }));

    await service.updateOrderStatus('order-1', 'OUT_FOR_DELIVERY', 'admin-1');

    const expectedEta = new Date(NOW.getTime() + 900 * 1000);
    expect(txOrderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'OUT_FOR_DELIVERY', estimatedDeliveryTime: expectedEta },
      }),
    );
  });

  it('OUT_FOR_DELIVERY: leaves the ETA untouched when deliveryDurationSeconds is null', async () => {
    const existing = orderFixture({
      status: 'PREPARING',
      deliveryMethod: 'DELIVERY',
      deliveryDurationSeconds: null,
    });
    build(existing, reloadedOrderFixture({ status: 'OUT_FOR_DELIVERY' }));

    await service.updateOrderStatus('order-1', 'OUT_FOR_DELIVERY', 'admin-1');

    expect(txOrderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'OUT_FOR_DELIVERY' } }),
    );
  });

  it('READY_FOR_PICKUP: sets the ETA to the transition time', async () => {
    const existing = orderFixture({
      status: 'PREPARING',
      deliveryMethod: 'PICKUP',
      deliveryDurationSeconds: null,
    });
    build(existing, reloadedOrderFixture({ status: 'READY_FOR_PICKUP', deliveryMethod: 'PICKUP' }));

    await service.updateOrderStatus('order-1', 'READY_FOR_PICKUP', 'admin-1');

    expect(txOrderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'READY_FOR_PICKUP', estimatedDeliveryTime: NOW },
      }),
    );
  });

  it.each([
    ['PENDING', 'CONFIRMED'],
    ['CONFIRMED', 'PREPARING'],
  ])('does not touch the ETA for an unrelated transition %s -> %s', async (from, target) => {
    const existing = orderFixture({ status: from, deliveryMethod: 'DELIVERY' });
    build(existing, reloadedOrderFixture({ status: target }));

    await service.updateOrderStatus('order-1', target as never, 'admin-1');

    expect(txOrderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: target } }),
    );
  });

  it('DELIVERED (terminal): does not write an ETA refresh', async () => {
    const existing = orderFixture({
      status: 'OUT_FOR_DELIVERY',
      deliveryMethod: 'DELIVERY',
      deliveryDurationSeconds: 900,
    });
    build(existing, reloadedOrderFixture({ status: 'DELIVERED' }));

    await service.updateOrderStatus('order-1', 'DELIVERED', 'admin-1');

    expect(txOrderUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'DELIVERED' } }),
    );
  });
});
