// This suite creates several drivers/orders per test (each driver alone is 2
// HTTP calls: create + login), easily exceeding the default 100 req/60s
// global ThrottlerGuard limit within a single test run. Raised for this
// process only — set before AppModule compiles (ConfigModule reads it then) —
// never touches the real default (.env stays 100 for actual deployments).
process.env.THROTTLE_LIMIT = '100000';

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
import { GoogleRoutesService } from '../src/modules/delivery-pricing/google-routes.service';

const D = (v: string) => new Prisma.Decimal(v);
const PASSWORD = 'correcthorsebattery';

const mockGoogleRoutesService = {
  computeRoute: jest.fn().mockResolvedValue({ distanceMeters: 5_000, durationSeconds: 600 }),
};

describe('Delivery drivers (Phase 1) — integration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;
  let settleCashOnDeliverySpy: jest.SpyInstance;
  let earnForOrderSpy: jest.SpyInstance;

  let categoryId: string;
  let checkoutItem: { id: string };
  const cleanupUserIds: string[] = [];

  async function registerCustomer() {
    const registered = await authService.register(
      {
        name: 'Driver-Spec Customer',
        email: `drv-customer-${randomUUID()}@phase-driver.local`,
        password: PASSWORD,
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    return registered;
  }

  async function registerAdmin() {
    const registered = await authService.register(
      {
        name: 'Driver-Spec Admin',
        email: `drv-admin-${randomUUID()}@phase-driver.local`,
        password: PASSWORD,
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    await prisma.user.update({ where: { id: registered.user.id }, data: { role: 'ADMIN' } });
    return authService.login({ email: registered.user.email as string, password: PASSWORD }, {});
  }

  async function registerCashier() {
    const registered = await authService.register(
      {
        name: 'Driver-Spec Cashier',
        email: `drv-cashier-${randomUUID()}@phase-driver.local`,
        password: PASSWORD,
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    await prisma.user.update({ where: { id: registered.user.id }, data: { role: 'CASHIER' } });
    return authService.login({ email: registered.user.email as string, password: PASSWORD }, {});
  }

  /** Creates a driver through the real admin HTTP endpoint (the only path
   * that matters to prove — driver creation is admin-only, ADMIN CRUD), then
   * obtains tokens via AuthService directly rather than a second real HTTP
   * call to the throttled (20 req/60s, see AUTH_THROTTLE) /auth/login route
   * — this suite creates many drivers across many tests, which would
   * otherwise blow that route's stricter per-route limit. The one test that
   * needs to prove the real HTTP /auth/login path works for a DRIVER
   * (`logs in through the normal /auth/login endpoint...`) calls it directly
   * instead of through this helper. */
  async function createAndLoginDriver(adminToken: string, name = 'Driver-Spec Driver') {
    const email = `drv-driver-${randomUUID()}@phase-driver.local`;
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/admin/drivers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name, email, password: PASSWORD, phone: '0500000001' });
    expect(createRes.status).toBe(201);
    cleanupUserIds.push(createRes.body.id);

    const tokens = await authService.login({ email, password: PASSWORD }, {});

    return {
      driverId: createRes.body.id as string,
      email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async function placeDeliveryOrder(accessToken: string) {
    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ menuItemId: checkoutItem.id, quantity: 1 });
    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        deliveryMethod: 'DELIVERY',
        paymentMethod: 'CASH',
        deliveryAddress: {
          title: 'Home',
          street: 'Main St',
          building: '1',
          city: 'Jeddah',
          latitude: 21.5433,
          longitude: 39.1728,
        },
      });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function placePickupOrder(accessToken: string) {
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

  async function advanceToStatus(adminToken: string, orderId: string, statuses: string[]) {
    for (const status of statuses) {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${orderId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status });
      expect(res.status).toBe(200);
    }
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
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
    settleCashOnDeliverySpy = jest
      .spyOn(app.get(PaymentsService), 'settleCashOnDelivery')
      .mockResolvedValue(undefined);
    earnForOrderSpy = jest
      .spyOn(app.get(LoyaltyService), 'earnForOrder')
      .mockResolvedValue(undefined);

    const category = await prisma.category.create({
      data: { nameAr: 'فئة السائقين', nameEn: 'Driver Spec Category' },
    });
    categoryId = category.id;
    checkoutItem = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف',
        nameEn: 'Driver Spec Item',
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
    settleCashOnDeliverySpy.mockClear();
    earnForOrderSpy.mockClear();
  });

  // ===========================================================================
  describe('Public registration cannot self-promote to DRIVER', () => {
    it('rejects an extra role field on POST /auth/register (whitelist strips/rejects unknown fields)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          name: 'Sneaky',
          email: `sneaky-${randomUUID()}@phase-driver.local`,
          password: PASSWORD,
          role: 'DRIVER',
        });
      expect(res.status).toBe(400);
    });

    it('a normal registration always lands as CUSTOMER, never DRIVER', async () => {
      const registered = await registerCustomer();
      expect(registered.user.role).toBe('CUSTOMER');
    });
  });

  // ===========================================================================
  describe('Admin driver management — access control', () => {
    it('rejects an unauthenticated caller with 401', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/admin/drivers');
      expect(res.status).toBe(401);
    });

    it('rejects a CUSTOMER with 403', async () => {
      const customer = await registerCustomer();
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/drivers')
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(res.status).toBe(403);
    });

    it('rejects a DRIVER from managing other drivers with 403', async () => {
      const admin = await registerAdmin();
      const driver = await createAndLoginDriver(admin.accessToken);
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/drivers')
        .set('Authorization', `Bearer ${driver.accessToken}`);
      expect(res.status).toBe(403);
    });

    it('rejects a CASHIER with 403 (driver management is ADMIN-only, unlike order status)', async () => {
      const cashier = await registerCashier();
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/drivers')
        .set('Authorization', `Bearer ${cashier.accessToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ===========================================================================
  describe('Admin driver CRUD', () => {
    it('creates, lists (paginated), views, and updates a driver — never leaking passwordHash', async () => {
      const admin = await registerAdmin();
      const driver = await createAndLoginDriver(admin.accessToken);

      const listRes = await request(app.getHttpServer())
        .get('/api/v1/admin/drivers?limit=1&page=1')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(listRes.status).toBe(200);
      expect(Array.isArray(listRes.body)).toBe(true);
      expect(listRes.body.length).toBeLessThanOrEqual(1);
      expect(JSON.stringify(listRes.body)).not.toContain('passwordHash');

      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/admin/drivers/${driver.driverId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.email).toBe(driver.email);
      expect(getRes.body.passwordHash).toBeUndefined();

      const updateRes = await request(app.getHttpServer())
        .patch(`/api/v1/admin/drivers/${driver.driverId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ phone: '0511111111' });
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.phone).toBe('0511111111');
    });

    it('deactivates and reactivates a driver via isActive', async () => {
      const admin = await registerAdmin();
      const driver = await createAndLoginDriver(admin.accessToken);

      const deactivateRes = await request(app.getHttpServer())
        .patch(`/api/v1/admin/drivers/${driver.driverId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ isActive: false });
      expect(deactivateRes.status).toBe(200);
      expect(deactivateRes.body.isActive).toBe(false);

      const reactivateRes = await request(app.getHttpServer())
        .patch(`/api/v1/admin/drivers/${driver.driverId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ isActive: true });
      expect(reactivateRes.status).toBe(200);
      expect(reactivateRes.body.isActive).toBe(true);
    });
  });

  // ===========================================================================
  describe('Driver login + deactivation blocking', () => {
    it('logs in through the real HTTP /auth/login endpoint with role DRIVER', async () => {
      const admin = await registerAdmin();
      const email = `drv-driver-${randomUUID()}@phase-driver.local`;
      const createRes = await request(app.getHttpServer())
        .post('/api/v1/admin/drivers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ name: 'HTTP Login Driver', email, password: PASSWORD });
      expect(createRes.status).toBe(201);
      cleanupUserIds.push(createRes.body.id);

      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.user.role).toBe('DRIVER');

      const meRes = await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${loginRes.body.accessToken}`);
      expect(meRes.status).toBe(200);
      expect(meRes.body.role).toBe('DRIVER');
    });

    it('a deactivated driver cannot log in', async () => {
      const admin = await registerAdmin();
      const driver = await createAndLoginDriver(admin.accessToken);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/drivers/${driver.driverId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ isActive: false });

      const loginRes = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: driver.email, password: PASSWORD });
      expect(loginRes.status).toBe(401);
    });

    it('blocks a still-valid, previously issued access token immediately on deactivation', async () => {
      const admin = await registerAdmin();
      const driver = await createAndLoginDriver(admin.accessToken);

      // Token still cryptographically valid — prove it works before deactivation.
      const before = await request(app.getHttpServer())
        .get('/api/v1/driver/orders')
        .set('Authorization', `Bearer ${driver.accessToken}`);
      expect(before.status).toBe(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/drivers/${driver.driverId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ isActive: false });

      const after = await request(app.getHttpServer())
        .get('/api/v1/driver/orders')
        .set('Authorization', `Bearer ${driver.accessToken}`);
      expect(after.status).toBe(401);
      expect(after.body.code).toBe('DRIVER_DEACTIVATED');
    });

    it('blocks token refresh after deactivation (session revoked)', async () => {
      const admin = await registerAdmin();
      const driver = await createAndLoginDriver(admin.accessToken);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/drivers/${driver.driverId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ isActive: false });

      const refreshRes = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: driver.refreshToken });
      expect(refreshRes.status).toBe(401);
    });
  });

  // ===========================================================================
  describe('Order assignment (ADMIN)', () => {
    it('assigns a driver to a DELIVERY order', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const driver = await createAndLoginDriver(admin.accessToken);
      const order = await placeDeliveryOrder(customer.accessToken);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driver.driverId });
      expect(res.status).toBe(200);
      expect(res.body.driverId).toBe(driver.driverId);
    });

    it('rejects assigning a driver to a PICKUP order', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const driver = await createAndLoginDriver(admin.accessToken);
      const order = await placePickupOrder(customer.accessToken);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driver.driverId });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('NOT_A_DELIVERY_ORDER');
    });

    it('rejects a CASHIER from assigning a driver (ADMIN-only override)', async () => {
      const admin = await registerAdmin();
      const cashier = await registerCashier();
      const customer = await registerCustomer();
      const driver = await createAndLoginDriver(admin.accessToken);
      const order = await placeDeliveryOrder(customer.accessToken);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${cashier.accessToken}`)
        .send({ driverId: driver.driverId });
      expect(res.status).toBe(403);
    });

    it('rejects assigning an inactive driver', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const driver = await createAndLoginDriver(admin.accessToken);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/drivers/${driver.driverId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ isActive: false });
      const order = await placeDeliveryOrder(customer.accessToken);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driver.driverId });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('DRIVER_NOT_AVAILABLE');
    });

    it('rejects reassignment for a CANCELLED order', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const driver = await createAndLoginDriver(admin.accessToken);
      const order = await placeDeliveryOrder(customer.accessToken);
      await advanceToStatus(admin.accessToken, order.id, ['cancelled']);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driver.driverId });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('ORDER_ALREADY_TERMINAL');
    });

    it("reassignment immediately revokes the previous driver's access", async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const driverA = await createAndLoginDriver(admin.accessToken, 'Driver A');
      const driverB = await createAndLoginDriver(admin.accessToken, 'Driver B');
      const order = await placeDeliveryOrder(customer.accessToken);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driverA.driverId });

      const seenByA = await request(app.getHttpServer())
        .get(`/api/v1/driver/orders/${order.id}`)
        .set('Authorization', `Bearer ${driverA.accessToken}`);
      expect(seenByA.status).toBe(200);

      // Reassign to driver B.
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driverB.driverId });

      const noLongerSeenByA = await request(app.getHttpServer())
        .get(`/api/v1/driver/orders/${order.id}`)
        .set('Authorization', `Bearer ${driverA.accessToken}`);
      expect(noLongerSeenByA.status).toBe(404);

      const seenByB = await request(app.getHttpServer())
        .get(`/api/v1/driver/orders/${order.id}`)
        .set('Authorization', `Bearer ${driverB.accessToken}`);
      expect(seenByB.status).toBe(200);
    });

    it('unassigns a driver (DELETE)', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const driver = await createAndLoginDriver(admin.accessToken);
      const order = await placeDeliveryOrder(customer.accessToken);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driver.driverId });

      const res = await request(app.getHttpServer())
        .delete(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.driverId).toBeNull();

      const seenByDriver = await request(app.getHttpServer())
        .get(`/api/v1/driver/orders/${order.id}`)
        .set('Authorization', `Bearer ${driver.accessToken}`);
      expect(seenByDriver.status).toBe(404);
    });

    it('a concurrent reassignment race resolves to exactly one winner (409 for the loser)', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const driverA = await createAndLoginDriver(admin.accessToken, 'Driver A');
      const driverB = await createAndLoginDriver(admin.accessToken, 'Driver B');
      const order = await placeDeliveryOrder(customer.accessToken);

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .patch(`/api/v1/admin/orders/${order.id}/driver`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send({ driverId: driverA.driverId }),
        request(app.getHttpServer())
          .patch(`/api/v1/admin/orders/${order.id}/driver`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send({ driverId: driverB.driverId }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      // Exactly one succeeds; the other loses the atomic claim (409) — the
      // UPDATE ... WHERE driverId = <original> statement itself serializes
      // the two concurrent writers at the database, so this is deterministic
      // regardless of request timing.
      expect(statuses).toEqual([200, 409]);

      const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect([driverA.driverId, driverB.driverId]).toContain(finalOrder.driverId);

      const historyCount = await prisma.orderDriverAssignmentHistory.count({
        where: { orderId: order.id },
      });
      expect(historyCount).toBe(1);
    });
  });

  // ===========================================================================
  describe('Driver-facing endpoints', () => {
    it("lists only own active assigned orders, excludes another driver's orders", async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const driverA = await createAndLoginDriver(admin.accessToken, 'Driver A');
      const driverB = await createAndLoginDriver(admin.accessToken, 'Driver B');
      const orderForA = await placeDeliveryOrder(customer.accessToken);
      const orderForB = await placeDeliveryOrder(customer.accessToken);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${orderForA.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driverA.driverId });
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${orderForB.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driverB.driverId });

      const listA = await request(app.getHttpServer())
        .get('/api/v1/driver/orders')
        .set('Authorization', `Bearer ${driverA.accessToken}`);
      expect(listA.status).toBe(200);
      const idsA = listA.body.map((o: { id: string }) => o.id);
      expect(idsA).toContain(orderForA.id);
      expect(idsA).not.toContain(orderForB.id);
    });

    it('404s a driver reading an order not assigned to them (no existence leak)', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const driverA = await createAndLoginDriver(admin.accessToken, 'Driver A');
      const driverB = await createAndLoginDriver(admin.accessToken, 'Driver B');
      const order = await placeDeliveryOrder(customer.accessToken);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driverA.driverId });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/driver/orders/${order.id}`)
        .set('Authorization', `Bearer ${driverB.accessToken}`);
      expect(res.status).toBe(404);
    });

    it('returns minimized fields — no email, includes items/address/amount to collect', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const driver = await createAndLoginDriver(admin.accessToken);
      const order = await placeDeliveryOrder(customer.accessToken);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driver.driverId });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/driver/orders/${order.id}`)
        .set('Authorization', `Bearer ${driver.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.customerEmail).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(customer.user.email);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.deliveryAddress.city).toBe('Jeddah');
      expect(res.body.amountToCollect).toBe(res.body.totalAmount); // CASH, unpaid
      expect(res.body.paymentMethod).toBe('cash');
    });

    it('pickup: PREPARING -> OUT_FOR_DELIVERY, rejects from PENDING, and is idempotent on repeat', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const driver = await createAndLoginDriver(admin.accessToken);
      const order = await placeDeliveryOrder(customer.accessToken);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driver.driverId });

      // Still PENDING — too early.
      const tooEarly = await request(app.getHttpServer())
        .patch(`/api/v1/driver/orders/${order.id}/pickup`)
        .set('Authorization', `Bearer ${driver.accessToken}`);
      expect(tooEarly.status).toBe(422);
      expect(tooEarly.body.code).toBe('INVALID_STATUS_TRANSITION');

      await advanceToStatus(admin.accessToken, order.id, ['confirmed', 'preparing']);

      const first = await request(app.getHttpServer())
        .patch(`/api/v1/driver/orders/${order.id}/pickup`)
        .set('Authorization', `Bearer ${driver.accessToken}`);
      expect(first.status).toBe(200);
      expect(first.body.status).toBe('outForDelivery');

      const historyAfterFirst = await prisma.orderStatusHistory.count({
        where: { orderId: order.id, toStatus: 'OUT_FOR_DELIVERY' },
      });
      expect(historyAfterFirst).toBe(1);

      // Repeat (retry/double-tap) — idempotent, no duplicate history row.
      const second = await request(app.getHttpServer())
        .patch(`/api/v1/driver/orders/${order.id}/pickup`)
        .set('Authorization', `Bearer ${driver.accessToken}`);
      expect(second.status).toBe(200);
      expect(second.body.status).toBe('outForDelivery');

      const historyAfterSecond = await prisma.orderStatusHistory.count({
        where: { orderId: order.id, toStatus: 'OUT_FOR_DELIVERY' },
      });
      expect(historyAfterSecond).toBe(1);
    });

    it('delivered: OUT_FOR_DELIVERY -> DELIVERED, settles COD + earns loyalty exactly once, rejects from PREPARING', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const driver = await createAndLoginDriver(admin.accessToken);
      const order = await placeDeliveryOrder(customer.accessToken);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driver.driverId });
      await advanceToStatus(admin.accessToken, order.id, ['confirmed', 'preparing']);

      const tooEarly = await request(app.getHttpServer())
        .patch(`/api/v1/driver/orders/${order.id}/delivered`)
        .set('Authorization', `Bearer ${driver.accessToken}`);
      expect(tooEarly.status).toBe(422);

      await request(app.getHttpServer())
        .patch(`/api/v1/driver/orders/${order.id}/pickup`)
        .set('Authorization', `Bearer ${driver.accessToken}`);

      const first = await request(app.getHttpServer())
        .patch(`/api/v1/driver/orders/${order.id}/delivered`)
        .set('Authorization', `Bearer ${driver.accessToken}`);
      expect(first.status).toBe(200);
      expect(first.body.status).toBe('delivered');
      expect(settleCashOnDeliverySpy).toHaveBeenCalledTimes(1);
      expect(earnForOrderSpy).toHaveBeenCalledTimes(1);

      // Repeat — idempotent, no duplicate settlement/loyalty side effects.
      const second = await request(app.getHttpServer())
        .patch(`/api/v1/driver/orders/${order.id}/delivered`)
        .set('Authorization', `Bearer ${driver.accessToken}`);
      expect(second.status).toBe(200);
      expect(settleCashOnDeliverySpy).toHaveBeenCalledTimes(1);
      expect(earnForOrderSpy).toHaveBeenCalledTimes(1);

      // Now appears in history, phone stripped.
      const history = await request(app.getHttpServer())
        .get('/api/v1/driver/orders/history')
        .set('Authorization', `Bearer ${driver.accessToken}`);
      expect(history.status).toBe(200);
      const historyEntry = history.body.find((o: { id: string }) => o.id === order.id);
      expect(historyEntry).toBeDefined();
      expect(historyEntry.customerPhone).toBeNull();
    });

    it('a driver cannot act on an order after being reassigned away mid-delivery', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const driverA = await createAndLoginDriver(admin.accessToken, 'Driver A');
      const driverB = await createAndLoginDriver(admin.accessToken, 'Driver B');
      const order = await placeDeliveryOrder(customer.accessToken);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driverA.driverId });
      await advanceToStatus(admin.accessToken, order.id, ['confirmed', 'preparing']);
      await request(app.getHttpServer())
        .patch(`/api/v1/driver/orders/${order.id}/pickup`)
        .set('Authorization', `Bearer ${driverA.accessToken}`);

      // Reassign mid-delivery.
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driverB.driverId });

      const blockedForA = await request(app.getHttpServer())
        .patch(`/api/v1/driver/orders/${order.id}/delivered`)
        .set('Authorization', `Bearer ${driverA.accessToken}`);
      expect(blockedForA.status).toBe(404);

      const allowedForB = await request(app.getHttpServer())
        .patch(`/api/v1/driver/orders/${order.id}/delivered`)
        .set('Authorization', `Bearer ${driverB.accessToken}`);
      expect(allowedForB.status).toBe(200);
    });

    it("rejects a driver from acting on another driver's order (403/404, never a 200)", async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const driverA = await createAndLoginDriver(admin.accessToken, 'Driver A');
      const driverB = await createAndLoginDriver(admin.accessToken, 'Driver B');
      const order = await placeDeliveryOrder(customer.accessToken);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driverA.driverId });
      await advanceToStatus(admin.accessToken, order.id, ['confirmed', 'preparing']);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/driver/orders/${order.id}/pickup`)
        .set('Authorization', `Bearer ${driverB.accessToken}`);
      expect(res.status).toBe(404);

      const stillPreparing = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(stillPreparing.status).toBe('PREPARING');
    });
  });
});
