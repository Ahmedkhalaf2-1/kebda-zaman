import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
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
 * Manual Kitchen Preparation Time / ETA (setPreparationTime): KITCHEN/ADMIN
 * chooses minutes-to-ready; the server clock is authoritative and this must
 * never itself move `status`. Only usable while the order is actually in the
 * kitchen preparation phase (CONFIRMED/PREPARING) — every other status,
 * terminal or not, is rejected with ORDER_NOT_IN_PREPARATION. Uses
 * fake/deterministic time throughout (jest.useFakeTimers) rather than
 * wall-clock tolerance windows, and a mocked PrismaService (no DB),
 * mirroring orders.service.capture-void.spec.ts's established pattern.
 */
describe('OrdersService.setPreparationTime', () => {
  const NOW = new Date('2026-01-01T12:00:00.000Z');

  function orderFixture(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'order-1',
      orderNumber: 'KZ-260101-test',
      status: 'CONFIRMED',
      deliveryMethod: 'PICKUP',
      paymentMethod: 'CASH',
      deliveryDurationSeconds: null,
      createdAt: NOW,
      ...overrides,
    };
  }

  let prisma: { order: { findUnique: jest.Mock; update: jest.Mock } };
  let service: OrdersService;
  let currentOrder: Record<string, unknown> | null;

  /** Sets both what `findUnique` returns AND the base row `update`'s mock
   * merges its `data` onto — matches how a real Prisma `update` returns the
   * full row, not just the columns that were written. */
  function setOrder(fixture: Record<string, unknown> | null) {
    currentOrder = fixture;
    prisma.order.findUnique.mockResolvedValue(fixture);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    currentOrder = null;

    prisma = {
      order: {
        findUnique: jest.fn(),
        update: jest.fn((args) =>
          Promise.resolve({
            ...(currentOrder as Record<string, unknown>),
            ...args.data,
            id: args.where.id,
            items: [],
          }),
        ),
      },
    };

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
      {} as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('404s when the order does not exist', async () => {
    setOrder(null);

    await expect(service.setPreparationTime('missing', 20)).rejects.toMatchObject({
      response: { code: 'ORDER_NOT_FOUND' },
    });
    await expect(service.setPreparationTime('missing', 20)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it.each([
    'PENDING',
    'OUT_FOR_DELIVERY',
    'READY_FOR_PICKUP',
    'DELIVERED',
    'PICKED_UP',
    'CANCELLED',
  ])(
    '422s (ORDER_NOT_IN_PREPARATION) for a %s order — only CONFIRMED/PREPARING are in the kitchen phase — and never writes',
    async (status) => {
      setOrder(orderFixture({ status }));

      await expect(service.setPreparationTime('order-1', 20)).rejects.toMatchObject({
        response: { code: 'ORDER_NOT_IN_PREPARATION' },
      });
      await expect(service.setPreparationTime('order-1', 20)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(prisma.order.update).not.toHaveBeenCalled();
    },
  );

  it.each(['CONFIRMED', 'PREPARING'])(
    'allows a %s order (in the kitchen preparation phase)',
    async (status) => {
      setOrder(orderFixture({ status }));

      await expect(service.setPreparationTime('order-1', 20)).resolves.toBeDefined();
    },
  );

  it('PICKUP: sets readyAt = now + minutes as the ETA and persists preparationTimeMinutes', async () => {
    setOrder(orderFixture({ deliveryMethod: 'PICKUP' }));

    const result = await service.setPreparationTime('order-1', 20);

    const expectedReadyAt = new Date(NOW.getTime() + 20 * 60_000);
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-1' },
        data: { preparationTimeMinutes: 20, estimatedDeliveryTime: expectedReadyAt },
      }),
    );
    expect(result.preparationTimeMinutes).toBe(20);
    expect(result.estimatedDeliveryTime).toBe(expectedReadyAt.toISOString());
  });

  it('DELIVERY with a known deliveryDurationSeconds: ETA = now + minutes + travel time', async () => {
    setOrder(orderFixture({ deliveryMethod: 'DELIVERY', deliveryDurationSeconds: 600 }));

    const result = await service.setPreparationTime('order-1', 20);

    const expectedEta = new Date(NOW.getTime() + 20 * 60_000 + 600 * 1000);
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { preparationTimeMinutes: 20, estimatedDeliveryTime: expectedEta },
      }),
    );
    expect(result.estimatedDeliveryTime).toBe(expectedEta.toISOString());
  });

  it('DELIVERY with a null deliveryDurationSeconds: falls back to readyAt (never fails the request)', async () => {
    setOrder(orderFixture({ deliveryMethod: 'DELIVERY', deliveryDurationSeconds: null }));

    const result = await service.setPreparationTime('order-1', 20);

    const expectedReadyAt = new Date(NOW.getTime() + 20 * 60_000);
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { preparationTimeMinutes: 20, estimatedDeliveryTime: expectedReadyAt },
      }),
    );
    expect(result.estimatedDeliveryTime).toBe(expectedReadyAt.toISOString());
  });

  it('never writes `status` — this is an ETA-only write', async () => {
    setOrder(orderFixture());

    await service.setPreparationTime('order-1', 20);

    const data = prisma.order.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('status');
  });

  it('the kitchen-shaped response carries both preparationTimeMinutes and estimatedDeliveryTime', async () => {
    setOrder(orderFixture());

    const result = await service.setPreparationTime('order-1', 15);

    expect(result).toMatchObject({
      preparationTimeMinutes: 15,
      estimatedDeliveryTime: expect.any(String),
    });
  });
});
