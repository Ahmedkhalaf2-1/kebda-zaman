import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma, UserRole } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { AuthService } from '../src/modules/auth/auth.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';

const D = (v: string) => new Prisma.Decimal(v);

describe('Admin Reports (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;

  let categoryId: string;
  let itemA: { id: string };
  let itemB: { id: string };
  let deliveryZoneId: string;
  const cleanupUserIds: string[] = [];

  async function registerCustomer() {
    const registered = await authService.register(
      {
        name: 'Rep Customer',
        email: `rep-customer-${randomUUID()}@phase7.local`,
        password: 'correcthorsebattery',
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    return registered;
  }

  async function registerWithRole(role: 'ADMIN' | 'CASHIER') {
    const registered = await authService.register(
      {
        name: `Rep ${role}`,
        email: `rep-${role.toLowerCase()}-${randomUUID()}@phase7.local`,
        password: 'correcthorsebattery',
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    await prisma.user.update({ where: { id: registered.user.id }, data: { role: role as UserRole } });
    return authService.login(
      { email: registered.user.email as string, password: 'correcthorsebattery' },
      {},
    );
  }

  async function addToCart(accessToken: string, menuItemId: string, quantity: number) {
    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ menuItemId, quantity });
  }

  async function checkout(
    accessToken: string,
    opts: { deliveryMethod: 'PICKUP' | 'DELIVERY'; paymentMethod: 'CASH' | 'CARD' },
  ) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        ...opts,
        ...(opts.deliveryMethod === 'DELIVERY'
          ? {
              deliveryAddress: { title: 'Home', street: 'Main St', building: '1', city: 'Cairo' },
              deliveryZoneId,
            }
          : {}),
      });
    expect(res.status).toBe(201);
    return res.body;
  }

  // Every caller below checks out with deliveryMethod: 'PICKUP', so completion
  // runs through the pickup lifecycle (readyForPickup -> pickedUp).
  async function walkToDelivered(adminToken: string, orderId: string) {
    for (const status of ['confirmed', 'preparing', 'readyForPickup', 'pickedUp']) {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${orderId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status });
      expect(res.status).toBe(200);
    }
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

    const category = await prisma.category.create({
      data: { nameAr: 'فئة التقارير', nameEn: 'Phase 7A Reports Category' },
    });
    categoryId = category.id;
    itemA = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف أ',
        nameEn: 'Report Item A',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: D('50.00'),
      },
    });
    itemB = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف ب',
        nameEn: 'Report Item B',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        // Above the seeded RestaurantSettings.minOrderAmount (50) on its own,
        // so a single-quantity order of just this item clears checkout's floor.
        basePrice: D('55.00'),
      },
    });

    const zone = await prisma.deliveryZone.create({
      data: { nameAr: 'منطقة التقارير', nameEn: 'Reports Zone', deliveryFee: D('10.00'), minimumOrder: D('0.00') },
    });
    deliveryZoneId = zone.id;
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
    await prisma.deliveryZone.delete({ where: { id: deliveryZoneId } });
    await app.close();
  });

  const endpoints = [
    '/api/v1/admin/reports/overview',
    '/api/v1/admin/reports/sales',
    '/api/v1/admin/reports/orders',
    '/api/v1/admin/reports/top-items',
  ];

  // ===========================================================================
  describe('Authorization', () => {
    it('allows ADMIN on every reports endpoint', async () => {
      const admin = await registerWithRole('ADMIN');
      for (const path of endpoints) {
        const res = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${admin.accessToken}`);
        expect(res.status).toBe(200);
      }
    });

    it('rejects CASHIER with 403 on every reports endpoint', async () => {
      const cashier = await registerWithRole('CASHIER');
      for (const path of endpoints) {
        const res = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${cashier.accessToken}`);
        expect(res.status).toBe(403);
      }
    });

    it('rejects CUSTOMER with 403 on every reports endpoint', async () => {
      const customer = await registerCustomer();
      for (const path of endpoints) {
        const res = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${customer.accessToken}`);
        expect(res.status).toBe(403);
      }
    });

    it('rejects an unauthenticated caller with 401', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/admin/reports/overview');
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  describe('Date range validation', () => {
    it('rejects from after to with 400 INVALID_DATE_RANGE', async () => {
      const admin = await registerWithRole('ADMIN');
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/reports/overview')
        .query({ from: '2026-02-01', to: '2026-01-01' })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_DATE_RANGE');
    });
  });

  // ===========================================================================
  describe('Empty-data zero behavior', () => {
    it('returns zeroed fields for a date range with no orders', async () => {
      const admin = await registerWithRole('ADMIN');
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/reports/overview')
        .query({ from: '2001-01-01', to: '2001-01-31' })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        totalRevenue: 0,
        totalOrders: 0,
        deliveredOrders: 0,
        cancelledOrders: 0,
        averageOrderValue: 0,
        newCustomers: 0,
        deliveryOrders: 0,
        pickupOrders: 0,
        cashOrders: 0,
        cardOrders: 0,
      });
    });

    it('returns zero-count entries for every known enum value with no orders', async () => {
      const admin = await registerWithRole('ADMIN');
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/reports/orders')
        .query({ from: '2001-01-01', to: '2001-01-31' })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.byStatus).toHaveLength(8);
      expect(res.body.byFulfillmentType).toHaveLength(2);
      expect(res.body.byPaymentMethod).toHaveLength(3);
      expect(res.body.byStatus.every((s: { count: number }) => s.count === 0)).toBe(true);
      expect(res.body.byFulfillmentType.every((s: { count: number }) => s.count === 0)).toBe(true);
      expect(res.body.byPaymentMethod.every((s: { count: number }) => s.count === 0)).toBe(true);
    });

    it('returns an empty array from top-items with no orders', async () => {
      const admin = await registerWithRole('ADMIN');
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/reports/top-items')
        .query({ from: '2001-01-01', to: '2001-01-31' })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  // ===========================================================================
  describe('Completed-order revenue + date filtering', () => {
    it('counts revenue/averageOrderValue from both terminal-success statuses (DELIVERED + PICKED_UP), scoped to the given window', async () => {
      const admin = await registerWithRole('ADMIN');
      const customer = await registerCustomer();
      const from = new Date().toISOString();

      // Baseline count up to `from` — the dev DB carries orders from other
      // test suites, so we compare deltas rather than assuming zero.
      const baseline = await request(app.getHttpServer())
        .get('/api/v1/admin/reports/overview')
        .query({ from: '2001-01-01', to: from })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      const baselineOrders = baseline.body.totalOrders;

      // PICKUP order walked all the way to PICKED_UP.
      await addToCart(customer.accessToken, itemA.id, 1);
      const pickedUp = await checkout(customer.accessToken, {
        deliveryMethod: 'PICKUP',
        paymentMethod: 'CASH',
      });
      await walkToDelivered(admin.accessToken, pickedUp.id);

      // DELIVERY order walked all the way to DELIVERED.
      await addToCart(customer.accessToken, itemB.id, 1);
      const delivered = await checkout(customer.accessToken, {
        deliveryMethod: 'DELIVERY',
        paymentMethod: 'CARD',
      });
      for (const status of ['confirmed', 'preparing', 'outForDelivery', 'delivered']) {
        const step = await request(app.getHttpServer())
          .patch(`/api/v1/admin/orders/${delivered.id}/status`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send({ status });
        expect(step.status).toBe(200);
      }
      const to = new Date(Date.now() + 1000).toISOString();

      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/reports/overview')
        .query({ from, to })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.totalOrders).toBe(2);
      // Both the PICKED_UP pickup order and the DELIVERED delivery order count
      // as completed sales — neither terminal-success status is excluded.
      expect(res.body.deliveredOrders).toBe(2);
      expect(res.body.totalRevenue).toBe(pickedUp.totalAmount + delivered.totalAmount);
      expect(res.body.averageOrderValue).toBe((pickedUp.totalAmount + delivered.totalAmount) / 2);
      expect(res.body.pickupOrders).toBe(1);
      expect(res.body.deliveryOrders).toBe(1);
      expect(res.body.cashOrders).toBe(1);
      expect(res.body.cardOrders).toBe(1);

      // A range that ends right before this test's first order was placed
      // must exclude both orders entirely — the baseline count is unchanged.
      const before = await request(app.getHttpServer())
        .get('/api/v1/admin/reports/overview')
        .query({ from: '2001-01-01', to: from })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(before.status).toBe(200);
      expect(before.body.totalOrders).toBe(baselineOrders);
    });
  });

  // ===========================================================================
  describe('Top-items ordering', () => {
    it('sorts by quantitySold desc, then revenue desc', async () => {
      const admin = await registerWithRole('ADMIN');
      const customer = await registerCustomer();
      const from = new Date().toISOString();

      await addToCart(customer.accessToken, itemA.id, 3);
      const order1 = await checkout(customer.accessToken, {
        deliveryMethod: 'PICKUP',
        paymentMethod: 'CASH',
      });
      await walkToDelivered(admin.accessToken, order1.id);

      await addToCart(customer.accessToken, itemB.id, 1);
      const order2 = await checkout(customer.accessToken, {
        deliveryMethod: 'PICKUP',
        paymentMethod: 'CASH',
      });
      await walkToDelivered(admin.accessToken, order2.id);

      const to = new Date(Date.now() + 1000).toISOString();
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/reports/top-items')
        .query({ from, to, limit: 5 })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body[0].menuItemId).toBe(itemA.id);
      expect(res.body[0].quantitySold).toBe(3);
      expect(res.body[1].menuItemId).toBe(itemB.id);
      expect(res.body[1].quantitySold).toBe(1);
    });

    it('validates limit bounds (max 50)', async () => {
      const admin = await registerWithRole('ADMIN');
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/reports/top-items')
        .query({ limit: 51 })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(400);
    });
  });
});
