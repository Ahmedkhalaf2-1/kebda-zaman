import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { AuthService } from '../src/modules/auth/auth.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { LoyaltyService } from '../src/modules/loyalty/loyalty.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import { GoogleRoutesService } from '../src/modules/delivery-pricing/google-routes.service';

const D = (v: string) => new Prisma.Decimal(v);

const mockGoogleRoutesService = {
  computeRoute: jest.fn().mockResolvedValue({ distanceMeters: 5_000, durationSeconds: 600 }),
};

/**
 * Gates the FIRST of two concurrent calls to `prisma.order.findUnique` until
 * the SECOND call has itself started — guaranteeing both calls observe the
 * same pre-transition order status before either one's caller proceeds to
 * validate the transition and attempt its optimistic `updateMany` claim.
 * This makes the ORDER_STATUS_CHANGED (409) contract deterministic instead of
 * relying on incidental request timing.
 */
function gateFirstOfTwoOrderReads(prisma: PrismaService): { restore: () => void } {
  const original = prisma.order.findUnique.bind(prisma.order);
  let callCount = 0;
  let releaseFirstCall: () => void = () => undefined;
  const secondCallStarted = new Promise<void>((resolve) => {
    releaseFirstCall = resolve;
  });
  // Cast needed: Prisma's fluent client return type (chainable relation
  // loaders) doesn't structurally match a plain async function's Promise
  // return type, even though both are thenable and behave identically here.
  const spy = jest.spyOn(prisma.order, 'findUnique').mockImplementation(((
    args: Prisma.OrderFindUniqueArgs,
  ) => {
    return (async () => {
      callCount += 1;
      if (callCount === 1) {
        await secondCallStarted;
      } else if (callCount === 2) {
        releaseFirstCall();
      }
      return original(args);
    })();
  }) as unknown as typeof prisma.order.findUnique);
  return { restore: () => spy.mockRestore() };
}

describe('Admin Orders (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;
  let ordersService: OrdersService;
  let mockSendOrderStatusNotification: jest.Mock;
  let settleCashOnDeliverySpy: jest.SpyInstance;
  let earnForOrderSpy: jest.SpyInstance;

  let categoryId: string;
  let checkoutItem: { id: string };
  const cleanupUserIds: string[] = [];

  async function registerCustomer() {
    const registered = await authService.register(
      {
        name: 'AO Customer',
        email: `ao-customer-${randomUUID()}@phase7.local`,
        password: 'correcthorsebattery',
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    return registered;
  }

  async function registerAdmin() {
    const registered = await authService.register(
      {
        name: 'AO Admin',
        email: `ao-admin-${randomUUID()}@phase7.local`,
        password: 'correcthorsebattery',
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    await prisma.user.update({ where: { id: registered.user.id }, data: { role: 'ADMIN' } });
    // Re-issue tokens so the access token carries the ADMIN role claim.
    return authService.login(
      { email: registered.user.email as string, password: 'correcthorsebattery' },
      {},
    );
  }

  async function registerCashier() {
    const registered = await authService.register(
      {
        name: 'AO Cashier',
        email: `ao-cashier-${randomUUID()}@phase7.local`,
        password: 'correcthorsebattery',
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    await prisma.user.update({ where: { id: registered.user.id }, data: { role: 'CASHIER' } });
    // Re-issue tokens so the access token carries the CASHIER role claim.
    return authService.login(
      { email: registered.user.email as string, password: 'correcthorsebattery' },
      {},
    );
  }

  /** Defaults to PICKUP (most existing tests below don't care which method);
   * pass 'DELIVERY' to exercise the delivery-specific lifecycle instead. */
  async function placeOrder(accessToken: string, deliveryMethod: 'PICKUP' | 'DELIVERY' = 'PICKUP') {
    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ menuItemId: checkoutItem.id, quantity: 1 });
    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        deliveryMethod,
        paymentMethod: 'CASH',
        ...(deliveryMethod === 'DELIVERY'
          ? {
              deliveryAddress: {
                title: 'Home',
                street: 'Main St',
                building: '1',
                city: 'Cairo',
                latitude: 30.0444,
                longitude: 31.2357,
              },
            }
          : {}),
      });
    expect(res.status).toBe(201);
    return res.body;
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(NotificationsService)
      .useValue({
        sendOrderStatusNotification: jest
          .fn()
          .mockResolvedValue({ successCount: 0, failureCount: 0, invalidTokens: [] }),
      })
      .overrideProvider(GoogleRoutesService)
      .useValue(mockGoogleRoutesService)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    authService = app.get(AuthService);
    ordersService = app.get(OrdersService);
    mockSendOrderStatusNotification = app.get(NotificationsService)
      .sendOrderStatusNotification as jest.Mock;
    // COD settlement / loyalty earning are only exercised end-to-end
    // elsewhere (payments/loyalty suites); here we just need to observe
    // whether — and how many times — a committed DELIVERED transition
    // invokes them, so they're spied-and-stubbed rather than left to run
    // for real against a synthetic CASH/PICKUP order.
    settleCashOnDeliverySpy = jest
      .spyOn(app.get(PaymentsService), 'settleCashOnDelivery')
      .mockResolvedValue(undefined);
    earnForOrderSpy = jest
      .spyOn(app.get(LoyaltyService), 'earnForOrder')
      .mockResolvedValue(undefined);

    const category = await prisma.category.create({
      data: { nameAr: 'فئة إدارة الطلبات', nameEn: 'Phase 7A Admin Orders Category' },
    });
    categoryId = category.id;
    checkoutItem = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف',
        nameEn: 'Admin Order Item',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: D('50.00'),
        imageUrl: 'https://example.test/img.png',
      },
    });
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { order: { userId: { in: cleanupUserIds } } } });
    await prisma.orderStatusHistory.deleteMany({
      where: { order: { userId: { in: cleanupUserIds } } },
    });
    await prisma.orderItemCustomization.deleteMany({
      where: { orderItem: { order: { userId: { in: cleanupUserIds } } } },
    });
    await prisma.orderItem.deleteMany({ where: { order: { userId: { in: cleanupUserIds } } } });
    await prisma.order.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    await prisma.menuItem.deleteMany({ where: { categoryId } });
    await prisma.category.delete({ where: { id: categoryId } });
    await app.close();
  });

  beforeEach(() => {
    mockSendOrderStatusNotification.mockClear();
    mockSendOrderStatusNotification.mockResolvedValue({
      successCount: 0,
      failureCount: 0,
      invalidTokens: [],
    });
    settleCashOnDeliverySpy.mockClear();
    settleCashOnDeliverySpy.mockResolvedValue(undefined);
    earnForOrderSpy.mockClear();
    earnForOrderSpy.mockResolvedValue(undefined);
  });

  // ===========================================================================
  describe('ADMIN access control', () => {
    it('allows an ADMIN to list orders', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/orders')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(200);
    });

    it('rejects a CUSTOMER with 403', async () => {
      const customer = await registerCustomer();
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/orders')
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated caller with 401', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/admin/orders');
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  describe('List / detail', () => {
    it('lists an order placed by any customer (no ownership restriction)', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);

      const list = await request(app.getHttpServer())
        .get('/api/v1/admin/orders')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(list.status).toBe(200);
      expect(list.body.some((o: { id: string }) => o.id === order.id)).toBe(true);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${order.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(detail.status).toBe(200);
      expect(detail.body.id).toBe(order.id);
    });

    it('404s for an unknown order id', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${randomUUID()}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(404);
    });

    it('reports deliveryMethod and paymentStatus on both the list and detail response', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken); // PICKUP / CASH -> PENDING

      // placeOrder() checks out as PICKUP with the CASH payment method, so the
      // fresh order is PICKUP/PENDING — assert that first (regression for the
      // response-contract gap: deliveryMethod/paymentStatus were previously
      // absent from OrderResponseDto entirely).
      const detailPending = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${order.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(detailPending.status).toBe(200);
      expect(detailPending.body.deliveryMethod).toBe('PICKUP');
      expect(detailPending.body.paymentStatus).toBe('PENDING');

      // Simulate a completed payment (the payments webhook flow itself is
      // out of scope for this fix) and confirm the mapper surfaces the new
      // status on both the admin list and detail responses.
      await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } });

      const detailPaid = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${order.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(detailPaid.status).toBe(200);
      expect(detailPaid.body.deliveryMethod).toBe('PICKUP');
      expect(detailPaid.body.paymentStatus).toBe('PAID');

      const list = await request(app.getHttpServer())
        .get('/api/v1/admin/orders')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(list.status).toBe(200);
      const listed = list.body.find((o: { id: string }) => o.id === order.id);
      expect(listed).toMatchObject({ deliveryMethod: 'PICKUP', paymentStatus: 'PAID' });
    });

    it('exposes nullable latitude/longitude on the DELIVERY order snapshot for both ADMIN and CASHIER (VO2.3)', async () => {
      const admin = await registerAdmin();
      const cashier = await registerCashier();
      const customer = await registerCustomer();

      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ menuItemId: checkoutItem.id, quantity: 1 });
      const checkout = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({
          deliveryMethod: 'DELIVERY',
          paymentMethod: 'CASH',
          deliveryAddress: {
            title: 'Home',
            street: 'Main St',
            building: '1',
            city: 'Cairo',
            latitude: 30.0444,
            longitude: 31.2357,
          },
        });
      expect(checkout.status).toBe(201);

      for (const caller of [admin, cashier]) {
        const detail = await request(app.getHttpServer())
          .get(`/api/v1/admin/orders/${checkout.body.id}`)
          .set('Authorization', `Bearer ${caller.accessToken}`);
        expect(detail.status).toBe(200);
        expect(detail.body.deliveryAddress.latitude).toBe(30.0444);
        expect(detail.body.deliveryAddress.longitude).toBe(31.2357);
      }
    });

    it('loads an order whose stored deliveryAddressJson predates coordinates without crashing (backward compatibility, VO2.3)', async () => {
      const admin = await registerAdmin();
      const order = await placeOrder((await registerCustomer()).accessToken, 'DELIVERY');

      // Simulate a pre-VO2.3 row: no latitude/longitude keys in the stored JSON at all.
      await prisma.order.update({
        where: { id: order.id },
        data: {
          deliveryAddressJson: { title: 'Home', street: 'Main St', building: '1', city: 'Cairo' },
        },
      });

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${order.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(detail.status).toBe(200);
      expect(detail.body.deliveryAddress.latitude).toBeNull();
      expect(detail.body.deliveryAddress.longitude).toBeNull();
    });
  });

  // ===========================================================================
  describe('Filtering / pagination', () => {
    it('filters by status', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);

      const pending = await request(app.getHttpServer())
        .get('/api/v1/admin/orders')
        .query({ status: 'pending' })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(pending.body.some((o: { id: string }) => o.id === order.id)).toBe(true);

      const delivered = await request(app.getHttpServer())
        .get('/api/v1/admin/orders')
        .query({ status: 'delivered' })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(delivered.body.find((o: { id: string }) => o.id === order.id)).toBeUndefined();
    });

    it('filters by q (order number)', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);

      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/orders')
        .query({ q: order.orderNumber })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.body.some((o: { id: string }) => o.id === order.id)).toBe(true);
    });

    it('respects page/limit', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/orders')
        .query({ page: 1, limit: 1 })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.length).toBeLessThanOrEqual(1);
    });
  });

  // ===========================================================================
  describe('Status transitions', () => {
    async function patchStatus(adminToken: string, orderId: string, body: Record<string, unknown>) {
      return request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${orderId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body);
    }

    it('walks the full valid DELIVERY lifecycle, writing history, notifying, and settling exactly once on DELIVERED', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken, 'DELIVERY');

      const sequence: Array<{ status: string; note?: string }> = [
        { status: 'confirmed', note: 'confirmed by kitchen' },
        { status: 'preparing' },
        { status: 'outForDelivery' },
        { status: 'delivered' },
      ];

      for (const step of sequence) {
        const res = await patchStatus(admin.accessToken, order.id, step);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe(step.status);
      }

      expect(mockSendOrderStatusNotification).toHaveBeenCalledTimes(4);
      expect(mockSendOrderStatusNotification).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          id: order.id,
          userId: customer.user.id,
          status: 'CONFIRMED',
          deliveryMethod: 'DELIVERY',
        }),
      );
      expect(mockSendOrderStatusNotification).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({ status: 'DELIVERED', deliveryMethod: 'DELIVERY' }),
      );

      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId: order.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(history.map((h) => h.toStatus)).toEqual([
        'PENDING',
        'CONFIRMED',
        'PREPARING',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
      ]);
      expect(history[1].fromStatus).toBe('PENDING');
      expect(history[1].changedByUserId).toBe(admin.user.id);
      expect(history[1].note).toBe('confirmed by kitchen');

      expect(settleCashOnDeliverySpy).toHaveBeenCalledTimes(1);
      expect(settleCashOnDeliverySpy).toHaveBeenCalledWith(order.id);
      expect(earnForOrderSpy).toHaveBeenCalledTimes(1);
      expect(earnForOrderSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: order.id, status: 'DELIVERED' }),
      );
    });

    it('walks the full valid PICKUP lifecycle (readyForPickup -> pickedUp), writing history, notifying, and settling exactly once on PICKED_UP', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken, 'PICKUP');

      const sequence: Array<{ status: string; note?: string }> = [
        { status: 'confirmed', note: 'confirmed by kitchen' },
        { status: 'preparing' },
        { status: 'readyForPickup' },
        { status: 'pickedUp' },
      ];

      for (const step of sequence) {
        const res = await patchStatus(admin.accessToken, order.id, step);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe(step.status);

        // READY_FOR_PICKUP is not a terminal-success status — it must never
        // settle payment or earn loyalty on its own.
        if (step.status === 'readyForPickup') {
          expect(settleCashOnDeliverySpy).not.toHaveBeenCalled();
          expect(earnForOrderSpy).not.toHaveBeenCalled();
        }
      }

      expect(mockSendOrderStatusNotification).toHaveBeenCalledTimes(4);
      expect(mockSendOrderStatusNotification).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ status: 'READY_FOR_PICKUP', deliveryMethod: 'PICKUP' }),
      );
      expect(mockSendOrderStatusNotification).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({ status: 'PICKED_UP', deliveryMethod: 'PICKUP' }),
      );

      const history = await prisma.orderStatusHistory.findMany({
        where: { orderId: order.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(history.map((h) => h.toStatus)).toEqual([
        'PENDING',
        'CONFIRMED',
        'PREPARING',
        'READY_FOR_PICKUP',
        'PICKED_UP',
      ]);
      expect(history[3].fromStatus).toBe('PREPARING');
      expect(history[4].fromStatus).toBe('READY_FOR_PICKUP');

      expect(settleCashOnDeliverySpy).toHaveBeenCalledTimes(1);
      expect(settleCashOnDeliverySpy).toHaveBeenCalledWith(order.id);
      expect(earnForOrderSpy).toHaveBeenCalledTimes(1);
      expect(earnForOrderSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: order.id, status: 'PICKED_UP' }),
      );
    });

    it('allows cancellation from PENDING', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);

      const res = await patchStatus(admin.accessToken, order.id, { status: 'cancelled' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cancelled');
    });

    it('allows cancellation from READY_FOR_PICKUP', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken, 'PICKUP');
      for (const status of ['confirmed', 'preparing', 'readyForPickup']) {
        expect((await patchStatus(admin.accessToken, order.id, { status })).status).toBe(200);
      }

      const res = await patchStatus(admin.accessToken, order.id, { status: 'cancelled' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cancelled');
    });

    it('rejects skipping a stage (PENDING -> PICKED_UP)', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken, 'PICKUP');

      const res = await patchStatus(admin.accessToken, order.id, { status: 'pickedUp' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
      expect(mockSendOrderStatusNotification).not.toHaveBeenCalled();
    });

    it('rejects a repeated transition to the same status', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);

      await patchStatus(admin.accessToken, order.id, { status: 'confirmed' });

      const res = await patchStatus(admin.accessToken, order.id, { status: 'confirmed' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('rejects the transition for a CUSTOMER caller (403)', async () => {
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);

      const res = await patchStatus(customer.accessToken, order.id, { status: 'confirmed' });
      expect(res.status).toBe(403);
    });

    it('allows a CASHIER to perform the same valid transitions as an ADMIN', async () => {
      const cashier = await registerCashier();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken, 'PICKUP');

      const res = await patchStatus(cashier.accessToken, order.id, { status: 'confirmed' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('confirmed');
    });

    it('an admin may continue transitioning an order already progressed by a cashier (no ownership lock)', async () => {
      const cashier = await registerCashier();
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken, 'PICKUP');

      expect(
        (await patchStatus(cashier.accessToken, order.id, { status: 'confirmed' })).status,
      ).toBe(200);
      const res = await patchStatus(admin.accessToken, order.id, { status: 'preparing' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('preparing');
    });

    it('a notification failure does not roll back an already-committed status change', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);
      mockSendOrderStatusNotification.mockRejectedValueOnce(new Error('FCM unavailable'));

      const res = await patchStatus(admin.accessToken, order.id, { status: 'confirmed' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('confirmed');

      const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(row.status).toBe('CONFIRMED');
      const history = await prisma.orderStatusHistory.findMany({ where: { orderId: order.id } });
      expect(history.some((h) => h.toStatus === 'CONFIRMED')).toBe(true);
    });

    // =========================================================================
    describe('Cross-method rejections (Fix 12A)', () => {
      it('rejects PICKUP PREPARING -> OUT_FOR_DELIVERY (422)', async () => {
        const admin = await registerAdmin();
        const customer = await registerCustomer();
        const order = await placeOrder(customer.accessToken, 'PICKUP');
        await patchStatus(admin.accessToken, order.id, { status: 'confirmed' });
        await patchStatus(admin.accessToken, order.id, { status: 'preparing' });

        const res = await patchStatus(admin.accessToken, order.id, { status: 'outForDelivery' });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
      });

      it('rejects DELIVERY PREPARING -> READY_FOR_PICKUP (422)', async () => {
        const admin = await registerAdmin();
        const customer = await registerCustomer();
        const order = await placeOrder(customer.accessToken, 'DELIVERY');
        await patchStatus(admin.accessToken, order.id, { status: 'confirmed' });
        await patchStatus(admin.accessToken, order.id, { status: 'preparing' });

        const res = await patchStatus(admin.accessToken, order.id, { status: 'readyForPickup' });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
      });

      it('rejects PICKUP READY_FOR_PICKUP -> DELIVERED (422)', async () => {
        const admin = await registerAdmin();
        const customer = await registerCustomer();
        const order = await placeOrder(customer.accessToken, 'PICKUP');
        for (const status of ['confirmed', 'preparing', 'readyForPickup']) {
          await patchStatus(admin.accessToken, order.id, { status });
        }

        const res = await patchStatus(admin.accessToken, order.id, { status: 'delivered' });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
      });

      it('rejects DELIVERY OUT_FOR_DELIVERY -> PICKED_UP (422)', async () => {
        const admin = await registerAdmin();
        const customer = await registerCustomer();
        const order = await placeOrder(customer.accessToken, 'DELIVERY');
        for (const status of ['confirmed', 'preparing', 'outForDelivery']) {
          await patchStatus(admin.accessToken, order.id, { status });
        }

        const res = await patchStatus(admin.accessToken, order.id, { status: 'pickedUp' });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
      });
    });

    // =========================================================================
    describe('Terminal statuses', () => {
      it('DELIVERED accepts no further transition', async () => {
        const admin = await registerAdmin();
        const customer = await registerCustomer();
        const order = await placeOrder(customer.accessToken, 'DELIVERY');
        for (const status of ['confirmed', 'preparing', 'outForDelivery', 'delivered']) {
          await patchStatus(admin.accessToken, order.id, { status });
        }

        const res = await patchStatus(admin.accessToken, order.id, { status: 'cancelled' });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
      });

      it('PICKED_UP accepts no further transition', async () => {
        const admin = await registerAdmin();
        const customer = await registerCustomer();
        const order = await placeOrder(customer.accessToken, 'PICKUP');
        for (const status of ['confirmed', 'preparing', 'readyForPickup', 'pickedUp']) {
          await patchStatus(admin.accessToken, order.id, { status });
        }

        const res = await patchStatus(admin.accessToken, order.id, { status: 'cancelled' });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
      });

      it('CANCELLED accepts no further transition', async () => {
        const admin = await registerAdmin();
        const customer = await registerCustomer();
        const order = await placeOrder(customer.accessToken);
        await patchStatus(admin.accessToken, order.id, { status: 'cancelled' });

        const res = await patchStatus(admin.accessToken, order.id, { status: 'confirmed' });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
      });
    });

    // =========================================================================
    describe('Status filters / mapper / customer status endpoint', () => {
      it('admin list filters by readyForPickup and pickedUp', async () => {
        const admin = await registerAdmin();
        const customer = await registerCustomer();
        const order = await placeOrder(customer.accessToken, 'PICKUP');
        await patchStatus(admin.accessToken, order.id, { status: 'confirmed' });
        await patchStatus(admin.accessToken, order.id, { status: 'preparing' });
        await patchStatus(admin.accessToken, order.id, { status: 'readyForPickup' });

        const ready = await request(app.getHttpServer())
          .get('/api/v1/admin/orders')
          .query({ status: 'readyForPickup' })
          .set('Authorization', `Bearer ${admin.accessToken}`);
        expect(ready.body.some((o: { id: string }) => o.id === order.id)).toBe(true);

        await patchStatus(admin.accessToken, order.id, { status: 'pickedUp' });

        const pickedUp = await request(app.getHttpServer())
          .get('/api/v1/admin/orders')
          .query({ status: 'pickedUp' })
          .set('Authorization', `Bearer ${admin.accessToken}`);
        expect(pickedUp.body.some((o: { id: string }) => o.id === order.id)).toBe(true);

        const stillReady = await request(app.getHttpServer())
          .get('/api/v1/admin/orders')
          .query({ status: 'readyForPickup' })
          .set('Authorization', `Bearer ${admin.accessToken}`);
        expect(stillReady.body.find((o: { id: string }) => o.id === order.id)).toBeUndefined();
      });

      it('GET /orders/:id/status maps readyForPickup/pickedUp and their history entries for the owning customer', async () => {
        const admin = await registerAdmin();
        const customer = await registerCustomer();
        const order = await placeOrder(customer.accessToken, 'PICKUP');
        for (const status of ['confirmed', 'preparing', 'readyForPickup']) {
          expect((await patchStatus(admin.accessToken, order.id, { status })).status).toBe(200);
        }

        const readyStatusRes = await request(app.getHttpServer())
          .get(`/api/v1/orders/${order.id}/status`)
          .set('Authorization', `Bearer ${customer.accessToken}`);
        expect(readyStatusRes.status).toBe(200);
        expect(readyStatusRes.body.status).toBe('readyForPickup');
        expect(readyStatusRes.body.statusHistory.map((h: { status: string }) => h.status)).toEqual([
          'pending',
          'confirmed',
          'preparing',
          'readyForPickup',
        ]);

        expect(
          (await patchStatus(admin.accessToken, order.id, { status: 'pickedUp' })).status,
        ).toBe(200);

        const pickedUpStatusRes = await request(app.getHttpServer())
          .get(`/api/v1/orders/${order.id}/status`)
          .set('Authorization', `Bearer ${customer.accessToken}`);
        expect(pickedUpStatusRes.status).toBe(200);
        expect(pickedUpStatusRes.body.status).toBe('pickedUp');
        expect(
          pickedUpStatusRes.body.statusHistory.map((h: { status: string }) => h.status),
        ).toEqual(['pending', 'confirmed', 'preparing', 'readyForPickup', 'pickedUp']);
      });
    });

    // =========================================================================
    describe('Concurrency (Fix 11 optimistic guard, preserved for both fulfillment methods)', () => {
      it('DELIVERY: a losing concurrent transition gets 409 ORDER_STATUS_CHANGED and never double-settles/double-earns', async () => {
        const admin = await registerAdmin();
        const customer = await registerCustomer();
        const order = await placeOrder(customer.accessToken, 'DELIVERY');
        for (const status of ['confirmed', 'preparing', 'outForDelivery']) {
          expect((await patchStatus(admin.accessToken, order.id, { status })).status).toBe(200);
        }
        settleCashOnDeliverySpy.mockClear();
        earnForOrderSpy.mockClear();

        const gate = gateFirstOfTwoOrderReads(prisma);
        try {
          const [res1, res2] = await Promise.all([
            patchStatus(admin.accessToken, order.id, { status: 'delivered' }),
            patchStatus(admin.accessToken, order.id, { status: 'delivered' }),
          ]);

          const statuses = [res1.status, res2.status].sort((a, b) => a - b);
          expect(statuses).toEqual([200, 409]);
          const loser = res1.status === 409 ? res1 : res2;
          expect(loser.body.code).toBe('ORDER_STATUS_CHANGED');
        } finally {
          gate.restore();
        }

        const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        expect(row.status).toBe('DELIVERED');
        expect(settleCashOnDeliverySpy).toHaveBeenCalledTimes(1);
        expect(earnForOrderSpy).toHaveBeenCalledTimes(1);
      });

      it('PICKUP: a losing concurrent transition gets 409 ORDER_STATUS_CHANGED and never double-settles/double-earns', async () => {
        const admin = await registerAdmin();
        const customer = await registerCustomer();
        const order = await placeOrder(customer.accessToken, 'PICKUP');
        for (const status of ['confirmed', 'preparing', 'readyForPickup']) {
          expect((await patchStatus(admin.accessToken, order.id, { status })).status).toBe(200);
        }
        settleCashOnDeliverySpy.mockClear();
        earnForOrderSpy.mockClear();

        const gate = gateFirstOfTwoOrderReads(prisma);
        try {
          const [res1, res2] = await Promise.all([
            patchStatus(admin.accessToken, order.id, { status: 'pickedUp' }),
            patchStatus(admin.accessToken, order.id, { status: 'pickedUp' }),
          ]);

          const statuses = [res1.status, res2.status].sort((a, b) => a - b);
          expect(statuses).toEqual([200, 409]);
          const loser = res1.status === 409 ? res1 : res2;
          expect(loser.body.code).toBe('ORDER_STATUS_CHANGED');
        } finally {
          gate.restore();
        }

        const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        expect(row.status).toBe('PICKED_UP');
        expect(settleCashOnDeliverySpy).toHaveBeenCalledTimes(1);
        expect(earnForOrderSpy).toHaveBeenCalledTimes(1);
      });
    });
  });
});
