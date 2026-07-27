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

describe('Admin Notification Center (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;
  let mockSendAdminNewOrderNotification: jest.Mock;

  let categoryId: string;
  let checkoutItem: { id: string };
  const cleanupUserIds: string[] = [];

  async function registerCustomer() {
    const registered = await authService.register(
      {
        name: 'AN Customer',
        email: `an-customer-${randomUUID()}@sprint1.local`,
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
        name: 'AN Admin',
        email: `an-admin-${randomUUID()}@sprint1.local`,
        password: 'correcthorsebattery',
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    await prisma.user.update({ where: { id: registered.user.id }, data: { role: 'ADMIN' } });
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
    return res.body as { id: string; orderNumber: string; totalAmount: number };
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
        sendAdminNewOrderNotification: jest
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
    mockSendAdminNewOrderNotification = app.get(NotificationsService)
      .sendAdminNewOrderNotification as jest.Mock;

    const category = await prisma.category.create({
      data: { nameAr: 'فئة مركز الإشعارات', nameEn: 'Sprint 1 Admin Notifications Category' },
    });
    categoryId = category.id;
    checkoutItem = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف',
        nameEn: 'Admin Notification Item',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: D('60.00'),
        imageUrl: 'https://example.test/img.png',
      },
    });
  });

  afterAll(async () => {
    await prisma.adminNotification.deleteMany({});
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

  beforeEach(async () => {
    await prisma.adminNotification.deleteMany({});
    mockSendAdminNewOrderNotification.mockClear();
    mockSendAdminNewOrderNotification.mockResolvedValue({
      successCount: 0,
      failureCount: 0,
      invalidTokens: [],
    });
  });

  // ===========================================================================
  describe('Access control', () => {
    it('allows an ADMIN to list notifications', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/notifications')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(200);
    });

    it('rejects a CUSTOMER with 403', async () => {
      const customer = await registerCustomer();
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/notifications')
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated caller with 401', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/admin/notifications');
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  describe('Created automatically on order placement', () => {
    it('creates exactly one NEW_ORDER notification after a successful checkout', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);

      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/notifications')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);

      const notification = res.body[0];
      expect(notification.type).toBe('NEW_ORDER');
      expect(notification.orderId).toBe(order.id);
      expect(notification.orderNumber).toBe(order.orderNumber);
      expect(notification.customerId).toBe(customer.user.id);
      expect(notification.customerName).toBe('AN Customer');
      expect(notification.totalAmount).toBe(order.totalAmount);
      expect(notification.isRead).toBe(false);
      expect(typeof notification.title).toBe('string');
      expect(typeof notification.body).toBe('string');
    });

    it('lists newest first and respects page/limit', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const first = await placeOrder(customer.accessToken);
      const second = await placeOrder(customer.accessToken);

      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/notifications')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.body.map((n: { orderId: string }) => n.orderId)).toEqual([second.id, first.id]);

      const paged = await request(app.getHttpServer())
        .get('/api/v1/admin/notifications')
        .query({ page: 1, limit: 1 })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(paged.body).toHaveLength(1);
      expect(paged.body[0].orderId).toBe(second.id);
    });

    it('does not create a notification when checkout fails (empty cart)', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();

      const failed = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
      expect(failed.status).toBe(409);

      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/notifications')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.body).toHaveLength(0);
    });
  });

  // ===========================================================================
  describe('Unread count', () => {
    it('counts only unread notifications', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      await placeOrder(customer.accessToken);
      await placeOrder(customer.accessToken);

      const before = await request(app.getHttpServer())
        .get('/api/v1/admin/notifications/unread-count')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(before.body).toEqual({ count: 2 });

      const list = await request(app.getHttpServer())
        .get('/api/v1/admin/notifications')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/notifications/${list.body[0].id}/read`)
        .set('Authorization', `Bearer ${admin.accessToken}`);

      const after = await request(app.getHttpServer())
        .get('/api/v1/admin/notifications/unread-count')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(after.body).toEqual({ count: 1 });
    });
  });

  // ===========================================================================
  describe('Mark as read / read all', () => {
    it('marks a single notification as read', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);
      const list = await request(app.getHttpServer())
        .get('/api/v1/admin/notifications')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      const notificationId = list.body[0].id;

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/notifications/${notificationId}/read`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.isRead).toBe(true);
      expect(res.body.orderId).toBe(order.id);

      const row = await prisma.adminNotification.findUniqueOrThrow({
        where: { id: notificationId },
      });
      expect(row.isRead).toBe(true);
    });

    it('404s for an unknown notification id', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/notifications/${randomUUID()}/read`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(404);
    });

    it('marks every unread notification as read', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      await placeOrder(customer.accessToken);
      await placeOrder(customer.accessToken);
      await placeOrder(customer.accessToken);

      const res = await request(app.getHttpServer())
        .patch('/api/v1/admin/notifications/read-all')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 3 });

      const remaining = await prisma.adminNotification.count({ where: { isRead: false } });
      expect(remaining).toBe(0);
    });
  });

  // ===========================================================================
  describe('Delete all', () => {
    it('clears every notification', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      await placeOrder(customer.accessToken);
      await placeOrder(customer.accessToken);

      const res = await request(app.getHttpServer())
        .delete('/api/v1/admin/notifications')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(204);

      const remaining = await prisma.adminNotification.count();
      expect(remaining).toBe(0);
    });
  });

  // ===========================================================================
  describe('FCM push to admin devices (Sprint 2)', () => {
    it('sends the admin push, with the correct payload, only after checkout commits', async () => {
      const customer = await registerCustomer();
      const order = await placeOrder(customer.accessToken);

      const stored = await prisma.adminNotification.findFirstOrThrow({
        where: { orderId: order.id },
      });

      expect(mockSendAdminNewOrderNotification).toHaveBeenCalledTimes(1);
      expect(mockSendAdminNewOrderNotification).toHaveBeenCalledWith({
        notificationId: stored.id,
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerName: 'AN Customer',
      });
    });

    it('never calls the admin push when checkout fails (empty cart)', async () => {
      const customer = await registerCustomer();

      const failed = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
      expect(failed.status).toBe(409);

      expect(mockSendAdminNewOrderNotification).not.toHaveBeenCalled();
    });

    it('a push failure never rolls back the order or its AdminNotification row', async () => {
      const customer = await registerCustomer();
      mockSendAdminNewOrderNotification.mockRejectedValueOnce(new Error('FCM unavailable'));

      const order = await placeOrder(customer.accessToken);

      const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(row.id).toBe(order.id);
      const notification = await prisma.adminNotification.findFirst({
        where: { orderId: order.id },
      });
      expect(notification).not.toBeNull();
    });
  });
});

// =============================================================================
// Recipient resolution: unit-level, against the REAL NotificationsService (not
// the mock above) — proves the ADMIN-only / isActive-only DeviceToken query
// itself, independent of Firebase. No credentials are configured in the test
// env, so `dispatch` short-circuits before ever calling Firebase and reports
// every *resolved* token as a failure — which is exactly what lets this test
// assert on resolution without needing to mock the Firebase SDK at all.
// =============================================================================
describe('NotificationsService.sendAdminNewOrderNotification recipient resolution', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let notificationsService: NotificationsService;
  let authService: AuthService;
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    notificationsService = app.get(NotificationsService);
    authService = app.get(AuthService);
  });

  afterAll(async () => {
    await prisma.deviceToken.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    await app.close();
  });

  it('only counts active ADMIN tokens, excluding customer and inactive tokens', async () => {
    const admin = await authService.register(
      {
        name: 'Resolution Admin',
        email: `resolution-admin-${randomUUID()}@sprint2.local`,
        password: 'correcthorsebattery',
      },
      {},
    );
    cleanupUserIds.push(admin.user.id);
    await prisma.user.update({ where: { id: admin.user.id }, data: { role: 'ADMIN' } });

    const customer = await authService.register(
      {
        name: 'Resolution Customer',
        email: `resolution-customer-${randomUUID()}@sprint2.local`,
        password: 'correcthorsebattery',
      },
      {},
    );
    cleanupUserIds.push(customer.user.id);

    await prisma.deviceToken.create({
      data: {
        userId: admin.user.id,
        token: `admin-active-${randomUUID()}`,
        platform: 'ANDROID',
        lastSeenAt: new Date(),
        isActive: true,
      },
    });
    await prisma.deviceToken.create({
      data: {
        userId: admin.user.id,
        token: `admin-inactive-${randomUUID()}`,
        platform: 'ANDROID',
        lastSeenAt: new Date(),
        isActive: false,
      },
    });
    await prisma.deviceToken.create({
      data: {
        userId: customer.user.id,
        token: `customer-active-${randomUUID()}`,
        platform: 'ANDROID',
        lastSeenAt: new Date(),
        isActive: true,
      },
    });

    const result = await notificationsService.sendAdminNewOrderNotification({
      notificationId: randomUUID(),
      orderId: randomUUID(),
      orderNumber: 'KZ-TEST-0001',
      customerName: 'Resolution Customer',
    });

    // Firebase isn't configured in the test env (isEnabled === false), so
    // `dispatch` reports every resolved token as a failure rather than
    // calling out — the count below is exactly the number of tokens the
    // ADMIN + isActive query resolved: only the one active admin token.
    expect(result).toEqual({ successCount: 0, failureCount: 1, invalidTokens: [] });
  });
});
