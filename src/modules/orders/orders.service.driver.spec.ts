import { NotFoundException } from '@nestjs/common';
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

/** Full shape needed by toOrderResponse/toAdminOrderResponse (assignDriver's return path). */
function fullOrderFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNumber: 'KZ-1',
    status: 'PENDING',
    deliveryMethod: 'DELIVERY',
    paymentMethod: 'CASH',
    paymentStatus: 'PENDING',
    driverId: null,
    userId: 'customer-1',
    user: {
      id: 'customer-1',
      fullName: 'Test Customer',
      email: 'c@example.com',
      phone: '0500000000',
      avatarUrl: null,
      role: 'CUSTOMER',
      isGuest: false,
      locale: 'en',
      createdAt: new Date(),
    },
    items: [],
    payments: [],
    deliveryAddressJson: { title: 'Home', street: 'x', building: '1', city: 'Jeddah' },
    subtotal: { toNumber: () => 50 },
    deliveryFee: { toNumber: () => 5 },
    tax: { toNumber: () => 0 },
    discount: { toNumber: () => 0 },
    totalAmount: { toNumber: () => 55 },
    createdAt: new Date(),
    estimatedDeliveryTime: null,
    deliveryZoneId: null,
    deliveryDistanceMeters: null,
    deliveryDurationSeconds: null,
    deliveryTierId: null,
    ...overrides,
  };
}

/** Trimmed shape matching `driverOrderInclude` (only fullName/phone selected). */
function driverOrderFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNumber: 'KZ-1',
    status: 'PREPARING',
    deliveryMethod: 'DELIVERY',
    paymentMethod: 'CASH',
    paymentStatus: 'PENDING',
    driverId: 'driver-1',
    totalAmount: { toNumber: () => 55 },
    deliveryAddressJson: { title: 'Home' },
    createdAt: new Date(),
    user: { fullName: 'Test Customer', phone: '0500000000' },
    items: [],
    ...overrides,
  };
}

describe('OrdersService — driver assignment + delivery actions', () => {
  let prisma: {
    order: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
    };
    orderStatusHistory: { create: jest.Mock };
    orderDriverAssignmentHistory: { create: jest.Mock };
    user: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let txOrderUpdateMany: jest.Mock;
  let txUserFindFirst: jest.Mock;
  let txOrderDriverAssignmentHistoryCreate: jest.Mock;
  let paymentsService: Record<string, jest.Mock>;
  let notificationsService: Record<string, jest.Mock>;
  let loyaltyService: Record<string, jest.Mock>;
  let service: OrdersService;

  function build() {
    txOrderUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    txUserFindFirst = jest.fn();
    txOrderDriverAssignmentHistoryCreate = jest.fn().mockResolvedValue({});
    const tx = {
      order: {
        findUnique: jest.fn(),
        updateMany: txOrderUpdateMany,
        findUniqueOrThrow: jest.fn().mockResolvedValue(fullOrderFixture()),
      },
      orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
      orderDriverAssignmentHistory: { create: txOrderDriverAssignmentHistoryCreate },
      user: { findFirst: txUserFindFirst },
    };

    prisma = {
      order: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
      },
      orderStatusHistory: { create: jest.fn() },
      orderDriverAssignmentHistory: { create: jest.fn() },
      user: { findFirst: jest.fn() },
      $transaction: jest.fn((callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    };
    // assignDriver reads `tx.order.findUnique` for the pre-claim order read —
    // route it through the same mock the test configures on `prisma.order.findUnique`
    // for readability (both represent "the order as currently persisted").
    tx.order.findUnique = prisma.order.findUnique;

    paymentsService = {
      captureAuthorizedPayment: jest.fn(),
      voidAuthorizedPayment: jest.fn(),
      compensateOrphanedCapture: jest.fn(),
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
    );
  }

  beforeEach(() => {
    build();
  });

  // =========================================================================
  describe('assignDriver', () => {
    it('assigns an active driver to a PENDING DELIVERY order and writes history', async () => {
      prisma.order.findUnique.mockResolvedValue(fullOrderFixture({ driverId: null }));
      txUserFindFirst.mockResolvedValue({ id: 'driver-1' });

      await service.assignDriver('order-1', 'driver-1', 'admin-1');

      expect(txOrderUpdateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', driverId: null },
        data: { driverId: 'driver-1', driverAssignmentVersion: { increment: 1 } },
      });
      expect(txOrderDriverAssignmentHistoryCreate).toHaveBeenCalledWith({
        data: {
          orderId: 'order-1',
          fromDriverId: null,
          toDriverId: 'driver-1',
          changedByUserId: 'admin-1',
        },
      });
    });

    it('rejects assigning a driver to a PICKUP order', async () => {
      prisma.order.findUnique.mockResolvedValue(fullOrderFixture({ deliveryMethod: 'PICKUP' }));

      await expect(service.assignDriver('order-1', 'driver-1', 'admin-1')).rejects.toMatchObject({
        response: { code: 'NOT_A_DELIVERY_ORDER' },
      });
      expect(txOrderUpdateMany).not.toHaveBeenCalled();
    });

    it.each(['DELIVERED', 'CANCELLED'])('rejects reassignment for a %s order', async (status) => {
      prisma.order.findUnique.mockResolvedValue(fullOrderFixture({ status }));

      await expect(service.assignDriver('order-1', 'driver-1', 'admin-1')).rejects.toMatchObject({
        response: { code: 'ORDER_ALREADY_TERMINAL' },
      });
    });

    it('rejects assigning a driver that is not found or not active', async () => {
      prisma.order.findUnique.mockResolvedValue(fullOrderFixture());
      txUserFindFirst.mockResolvedValue(null);

      await expect(service.assignDriver('order-1', 'driver-1', 'admin-1')).rejects.toMatchObject({
        response: { code: 'DRIVER_NOT_AVAILABLE' },
      });
      expect(txOrderUpdateMany).not.toHaveBeenCalled();
    });

    it('is a no-op (no history write) when re-assigning the same driver', async () => {
      prisma.order.findUnique.mockResolvedValue(fullOrderFixture({ driverId: 'driver-1' }));
      txUserFindFirst.mockResolvedValue({ id: 'driver-1' });

      await service.assignDriver('order-1', 'driver-1', 'admin-1');

      expect(txOrderUpdateMany).not.toHaveBeenCalled();
      expect(txOrderDriverAssignmentHistoryCreate).not.toHaveBeenCalled();
    });

    it('unassigns (driverId: null) an already-assigned order', async () => {
      prisma.order.findUnique.mockResolvedValue(fullOrderFixture({ driverId: 'driver-1' }));

      await service.assignDriver('order-1', null, 'admin-1');

      expect(txOrderUpdateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', driverId: 'driver-1' },
        data: { driverId: null, driverAssignmentVersion: { increment: 1 } },
      });
    });

    it('rejects a concurrent reassignment race with 409', async () => {
      prisma.order.findUnique.mockResolvedValue(fullOrderFixture({ driverId: null }));
      txUserFindFirst.mockResolvedValue({ id: 'driver-1' });
      txOrderUpdateMany.mockResolvedValue({ count: 0 }); // someone else reassigned it first

      await expect(service.assignDriver('order-1', 'driver-1', 'admin-1')).rejects.toMatchObject({
        response: { code: 'ASSIGNMENT_CHANGED' },
      });
    });
  });

  // =========================================================================
  describe('driverStartDelivery (pickup)', () => {
    it('transitions PREPARING -> OUT_FOR_DELIVERY for the assigned driver', async () => {
      prisma.order.findFirst.mockResolvedValue(driverOrderFixture({ status: 'PREPARING' }));
      prisma.order.findUnique.mockResolvedValue(
        fullOrderFixture({ status: 'PREPARING', driverId: 'driver-1' }),
      );
      prisma.order.findUniqueOrThrow.mockResolvedValue(
        driverOrderFixture({ status: 'OUT_FOR_DELIVERY' }),
      );

      const result = await service.driverStartDelivery('driver-1', 'order-1');

      expect(txOrderUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'order-1', status: 'PREPARING', driverId: 'driver-1' },
        }),
      );
      expect(result.status).toBe('outForDelivery');
    });

    it('404s an order not assigned to this driver (no ownership leak)', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(service.driverStartDelivery('driver-1', 'order-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('is idempotent when already OUT_FOR_DELIVERY (no duplicate transition/side effects)', async () => {
      prisma.order.findFirst.mockResolvedValue(driverOrderFixture({ status: 'OUT_FOR_DELIVERY' }));

      const result = await service.driverStartDelivery('driver-1', 'order-1');

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(result.status).toBe('outForDelivery');
    });

    it('rejects a skipped transition (still PENDING, never reached PREPARING)', async () => {
      prisma.order.findFirst.mockResolvedValue(driverOrderFixture({ status: 'PENDING' }));
      prisma.order.findUnique.mockResolvedValue(
        fullOrderFixture({ status: 'PENDING', driverId: 'driver-1' }),
      );

      await expect(service.driverStartDelivery('driver-1', 'order-1')).rejects.toMatchObject({
        response: { code: 'INVALID_STATUS_TRANSITION' },
      });
      expect(txOrderUpdateMany).not.toHaveBeenCalled();
    });

    it('rejects when the order was reassigned to a different driver between the ownership check and the claim', async () => {
      prisma.order.findFirst.mockResolvedValue(driverOrderFixture({ status: 'PREPARING' }));
      // Simulates a race: by the time updateOrderStatus re-reads the order, an
      // admin has already reassigned it to a different driver.
      prisma.order.findUnique.mockResolvedValue(
        fullOrderFixture({ status: 'PREPARING', driverId: 'driver-2' }),
      );

      await expect(service.driverStartDelivery('driver-1', 'order-1')).rejects.toMatchObject({
        response: { code: 'ORDER_NOT_ASSIGNED' },
      });
      expect(txOrderUpdateMany).not.toHaveBeenCalled();
    });

    it('rejects when the claim itself loses a concurrent race (reassigned mid-transaction)', async () => {
      prisma.order.findFirst.mockResolvedValue(driverOrderFixture({ status: 'PREPARING' }));
      prisma.order.findUnique.mockResolvedValue(
        fullOrderFixture({ status: 'PREPARING', driverId: 'driver-1' }),
      );
      txOrderUpdateMany.mockResolvedValue({ count: 0 });

      await expect(service.driverStartDelivery('driver-1', 'order-1')).rejects.toMatchObject({
        response: { code: 'ORDER_STATUS_CHANGED' },
      });
    });
  });

  // =========================================================================
  describe('driverMarkDelivered', () => {
    it('transitions OUT_FOR_DELIVERY -> DELIVERED and reuses COD settlement + loyalty earning', async () => {
      prisma.order.findFirst.mockResolvedValue(driverOrderFixture({ status: 'OUT_FOR_DELIVERY' }));
      prisma.order.findUnique.mockResolvedValue(
        fullOrderFixture({ status: 'OUT_FOR_DELIVERY', driverId: 'driver-1' }),
      );
      prisma.order.findUniqueOrThrow.mockResolvedValue(driverOrderFixture({ status: 'DELIVERED' }));

      const result = await service.driverMarkDelivered('driver-1', 'order-1');

      expect(paymentsService.settleCashOnDelivery).toHaveBeenCalledWith('order-1');
      expect(loyaltyService.earnForOrder).toHaveBeenCalled();
      expect(notificationsService.sendOrderStatusNotification).toHaveBeenCalled();
      expect(result.status).toBe('delivered');
    });

    it('rejects completion attempted directly from PREPARING (must pass through OUT_FOR_DELIVERY)', async () => {
      prisma.order.findFirst.mockResolvedValue(driverOrderFixture({ status: 'PREPARING' }));
      prisma.order.findUnique.mockResolvedValue(
        fullOrderFixture({ status: 'PREPARING', driverId: 'driver-1' }),
      );

      await expect(service.driverMarkDelivered('driver-1', 'order-1')).rejects.toMatchObject({
        response: { code: 'INVALID_STATUS_TRANSITION' },
      });
    });

    it('is idempotent when already DELIVERED (no duplicate loyalty/COD/notification side effects)', async () => {
      prisma.order.findFirst.mockResolvedValue(driverOrderFixture({ status: 'DELIVERED' }));

      const result = await service.driverMarkDelivered('driver-1', 'order-1');

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(paymentsService.settleCashOnDelivery).not.toHaveBeenCalled();
      expect(loyaltyService.earnForOrder).not.toHaveBeenCalled();
      expect(result.status).toBe('delivered');
    });
  });
});
