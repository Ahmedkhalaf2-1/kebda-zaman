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

const D = (v: string) => new Prisma.Decimal(v);

describe('Admin Orders (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;
  let mockSendOrderStatusNotification: jest.Mock;

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

  async function placeOrder(accessToken: string) {
    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ menuItemId: checkoutItem.id, quantity: 1 });
    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
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
    mockSendOrderStatusNotification = app.get(NotificationsService)
      .sendOrderStatusNotification as jest.Mock;

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
    it('walks the full valid lifecycle, writing history and notifying at each step', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);

      const sequence: Array<{ status: string; note?: string }> = [
        { status: 'confirmed', note: 'confirmed by kitchen' },
        { status: 'preparing' },
        { status: 'outForDelivery' },
        { status: 'delivered' },
      ];

      for (const step of sequence) {
        const res = await request(app.getHttpServer())
          .patch(`/api/v1/admin/orders/${order.id}/status`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(step);
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
          deliveryMethod: 'PICKUP',
        }),
      );
      expect(mockSendOrderStatusNotification).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({ status: 'DELIVERED', deliveryMethod: 'PICKUP' }),
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
    });

    it('allows cancellation from PENDING', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/status`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ status: 'cancelled' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cancelled');
    });

    it('rejects skipping a stage (PENDING -> DELIVERED)', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/status`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ status: 'delivered' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
      expect(mockSendOrderStatusNotification).not.toHaveBeenCalled();
    });

    it('rejects a repeated transition to the same status', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/status`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ status: 'confirmed' });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/status`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ status: 'confirmed' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('rejects any transition out of a terminal status (DELIVERED)', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);
      for (const status of ['confirmed', 'preparing', 'outForDelivery', 'delivered']) {
        await request(app.getHttpServer())
          .patch(`/api/v1/admin/orders/${order.id}/status`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send({ status });
      }

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/status`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ status: 'cancelled' });
      expect(res.status).toBe(422);
    });

    it('rejects the transition for a CUSTOMER caller (403)', async () => {
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/status`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ status: 'confirmed' });
      expect(res.status).toBe(403);
    });

    it('a notification failure does not roll back an already-committed status change', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);
      mockSendOrderStatusNotification.mockRejectedValueOnce(new Error('FCM unavailable'));

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/status`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ status: 'confirmed' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('confirmed');

      const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(row.status).toBe('CONFIRMED');
      const history = await prisma.orderStatusHistory.findMany({ where: { orderId: order.id } });
      expect(history.some((h) => h.toStatus === 'CONFIRMED')).toBe(true);
    });
  });
});
