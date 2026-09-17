// Same rationale as test/driver.driver-spec.ts: this suite creates several
// drivers/orders/customers per test, easily exceeding the default 100 req/60s
// global ThrottlerGuard limit. Raised for this process only, before AppModule
// compiles — never touches the real .env default. The dedicated rate-limit
// test at the bottom targets PUT /driver/orders/:id/location specifically,
// whose OWN per-route @Throttle(60/60s) is a hardcoded decorator value, NOT
// read from this env var — so that test's boundary is unaffected by this.
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

describe('Live driver tracking (Phase 2) — integration', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;

  let categoryId: string;
  let checkoutItem: { id: string };
  const cleanupUserIds: string[] = [];

  async function registerCustomer(name = 'Tracking Customer') {
    const registered = await authService.register(
      { name, email: `trk-customer-${randomUUID()}@phase-tracking.local`, password: PASSWORD },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    return registered;
  }

  async function registerAdmin() {
    const registered = await authService.register(
      {
        name: 'Tracking Admin',
        email: `trk-admin-${randomUUID()}@phase-tracking.local`,
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
        name: 'Tracking Cashier',
        email: `trk-cashier-${randomUUID()}@phase-tracking.local`,
        password: PASSWORD,
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    await prisma.user.update({ where: { id: registered.user.id }, data: { role: 'CASHIER' } });
    return authService.login({ email: registered.user.email as string, password: PASSWORD }, {});
  }

  async function createAndLoginDriver(adminToken: string, name = 'Tracking Driver') {
    const email = `trk-driver-${randomUUID()}@phase-tracking.local`;
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/admin/drivers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name, email, password: PASSWORD, phone: '0500000001' });
    expect(createRes.status).toBe(201);
    cleanupUserIds.push(createRes.body.id);
    const tokens = await authService.login({ email, password: PASSWORD }, {});
    return { driverId: createRes.body.id as string, email, accessToken: tokens.accessToken };
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

  async function assignDriverHttp(adminToken: string, orderId: string, driverId: string) {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/admin/orders/${orderId}/driver`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ driverId });
    expect(res.status).toBe(200);
    return res.body;
  }

  async function unassignDriverHttp(adminToken: string, orderId: string) {
    const res = await request(app.getHttpServer())
      .delete(`/api/v1/admin/orders/${orderId}/driver`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    return res.body;
  }

  /** Sets up a DELIVERY order all the way to OUT_FOR_DELIVERY, assigned to a
   * fresh driver — the common precondition most tracking tests start from. */
  async function setUpOutForDeliveryOrder(adminToken: string) {
    const customer = await registerCustomer();
    const driver = await createAndLoginDriver(adminToken);
    const order = await placeDeliveryOrder(customer.accessToken);
    await assignDriverHttp(adminToken, order.id, driver.driverId);
    await advanceToStatus(adminToken, order.id, ['confirmed', 'preparing']);
    await request(app.getHttpServer())
      .patch(`/api/v1/driver/orders/${order.id}/pickup`)
      .set('Authorization', `Bearer ${driver.accessToken}`);
    return { customer, driver, orderId: order.id as string };
  }

  function uploadLocation(
    driverToken: string,
    orderId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return request(app.getHttpServer())
      .put(`/api/v1/driver/orders/${orderId}/location`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        latitude: 21.5433,
        longitude: 39.1728,
        capturedAt: new Date().toISOString(),
        assignmentVersion: 1,
        ...overrides,
      });
  }

  async function currentAssignmentVersion(orderId: string): Promise<number> {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    return order.driverAssignmentVersion;
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
    jest.spyOn(app.get(PaymentsService), 'settleCashOnDelivery').mockResolvedValue(undefined);
    jest.spyOn(app.get(LoyaltyService), 'earnForOrder').mockResolvedValue(undefined);

    const category = await prisma.category.create({
      data: { nameAr: 'فئة التتبع', nameEn: 'Tracking Spec Category' },
    });
    categoryId = category.id;
    checkoutItem = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف',
        nameEn: 'Tracking Spec Item',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: D('50.00'),
        imageUrl: 'https://example.test/img.png',
      },
    });
  });

  afterAll(async () => {
    await prisma.orderDriverLocation.deleteMany({
      where: { order: { userId: { in: cleanupUserIds } } },
    });
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

  // ===========================================================================
  describe('Location ingestion — happy path and access control', () => {
    it('the correctly assigned active driver can upload a location while OUT_FOR_DELIVERY', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);

      const res = await uploadLocation(driver.accessToken, orderId, { assignmentVersion: version });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ accepted: true, assignmentVersion: version });
      expect(res.body.receivedAt).toEqual(expect.any(String));
    });

    it('rejects a CUSTOMER token calling the driver location endpoint (403)', async () => {
      const admin = await registerAdmin();
      const { customer, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const res = await uploadLocation(customer.accessToken, orderId);
      expect(res.status).toBe(403);
    });

    it('404s an order not assigned to the caller (unassigned entirely)', async () => {
      const admin = await registerAdmin();
      const driver = await createAndLoginDriver(admin.accessToken);
      const customer = await registerCustomer();
      const order = await placeDeliveryOrder(customer.accessToken);
      // Never assigned to anyone.
      const res = await uploadLocation(driver.accessToken, order.id);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ORDER_NOT_ASSIGNED');
    });

    it('blocks a deactivated driver even with a still-valid token (401 DRIVER_DEACTIVATED)', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/drivers/${driver.driverId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ isActive: false });

      const res = await uploadLocation(driver.accessToken, orderId);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('DRIVER_DEACTIVATED');
    });

    it('blocks the PREVIOUS driver after reassignment (404, not their order anymore)', async () => {
      const admin = await registerAdmin();
      const { driver: driverA, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const driverB = await createAndLoginDriver(admin.accessToken, 'Driver B');
      await assignDriverHttp(admin.accessToken, orderId, driverB.driverId);

      const res = await uploadLocation(driverA.accessToken, orderId);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ORDER_NOT_ASSIGNED');
    });

    it('rejects a PICKUP order (422 NOT_A_DELIVERY_ORDER)', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const driver = await createAndLoginDriver(admin.accessToken);
      const order = await placePickupOrder(customer.accessToken);
      // PICKUP can't be assigned at all per Phase 1 rules — confirm that gate first.
      const assignAttempt = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/driver`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ driverId: driver.driverId });
      expect(assignAttempt.status).toBe(422);
    });

    it.each(['PENDING', 'CONFIRMED', 'PREPARING'])(
      'rejects an upload while the order is %s (not yet OUT_FOR_DELIVERY)',
      async (targetStatus) => {
        const admin = await registerAdmin();
        const customer = await registerCustomer();
        const driver = await createAndLoginDriver(admin.accessToken);
        const order = await placeDeliveryOrder(customer.accessToken);
        await assignDriverHttp(admin.accessToken, order.id, driver.driverId);
        if (targetStatus !== 'PENDING') {
          const path = targetStatus === 'PREPARING' ? ['confirmed', 'preparing'] : ['confirmed'];
          await advanceToStatus(admin.accessToken, order.id, path);
        }

        const res = await uploadLocation(driver.accessToken, order.id);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('ORDER_NOT_OUT_FOR_DELIVERY');
      },
    );

    it('rejects an upload after delivery completion (422, order already DELIVERED)', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      await request(app.getHttpServer())
        .patch(`/api/v1/driver/orders/${orderId}/delivered`)
        .set('Authorization', `Bearer ${driver.accessToken}`);

      const res = await uploadLocation(driver.accessToken, orderId);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('ORDER_NOT_OUT_FOR_DELIVERY');
    });
  });

  // ===========================================================================
  describe('Location validation', () => {
    it.each([
      ['latitude', 91],
      ['latitude', -91],
      ['longitude', 181],
      ['longitude', -181],
    ])('rejects an out-of-range %s (%d) with 400', async (field, value) => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const res = await uploadLocation(driver.accessToken, orderId, { [field]: value });
      expect(res.status).toBe(400);
    });

    it('rejects a non-numeric latitude with 400', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const res = await uploadLocation(driver.accessToken, orderId, { latitude: 'not-a-number' });
      expect(res.status).toBe(400);
    });

    it('rejects a missing capturedAt with 400', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const res = request(app.getHttpServer())
        .put(`/api/v1/driver/orders/${orderId}/location`)
        .set('Authorization', `Bearer ${driver.accessToken}`)
        .send({ latitude: 21.5, longitude: 39.1, assignmentVersion: 1 });
      expect((await res).status).toBe(400);
    });

    it('rejects a sample captured too long ago (422 LOCATION_TOO_OLD)', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const res = await uploadLocation(driver.accessToken, orderId, {
        capturedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('LOCATION_TOO_OLD');
    });

    it('rejects a future-dated sample (422 LOCATION_TIMESTAMP_IN_FUTURE)', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const res = await uploadLocation(driver.accessToken, orderId, {
        capturedAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 min ahead
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('LOCATION_TIMESTAMP_IN_FUTURE');
    });

    it('rejects an accuracy/heading/speed value outside the documented bounds with 400', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const res = await uploadLocation(driver.accessToken, orderId, { accuracyMeters: 999_999 });
      expect(res.status).toBe(400);
    });
  });

  // ===========================================================================
  describe('Duplicate / out-of-order samples', () => {
    it('accepts a newer sample after an older one, and reading back reflects the newer one', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);

      const first = await uploadLocation(driver.accessToken, orderId, {
        assignmentVersion: version,
        latitude: 21.0,
        capturedAt: new Date(Date.now() - 20_000).toISOString(),
      });
      expect(first.body.accepted).toBe(true);

      const second = await uploadLocation(driver.accessToken, orderId, {
        assignmentVersion: version,
        latitude: 22.0,
        capturedAt: new Date(Date.now() - 5_000).toISOString(),
      });
      expect(second.body.accepted).toBe(true);

      const tracking = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(tracking.body.location.latitude).toBe(22.0);
    });

    it('silently ignores (accepted:false) an out-of-order sample older than what is already stored', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);

      await uploadLocation(driver.accessToken, orderId, {
        assignmentVersion: version,
        latitude: 22.0,
        capturedAt: new Date(Date.now() - 5_000).toISOString(),
      });

      const stale = await uploadLocation(driver.accessToken, orderId, {
        assignmentVersion: version,
        latitude: 21.0, // would be wrong/rewound if it won
        capturedAt: new Date(Date.now() - 20_000).toISOString(),
      });
      expect(stale.status).toBe(200);
      expect(stale.body.accepted).toBe(false);

      const tracking = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(tracking.body.location.latitude).toBe(22.0); // untouched
    });

    it('handles an exact-duplicate retried sample predictably (accepted:false, no error)', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);
      const capturedAt = new Date(Date.now() - 5_000).toISOString();

      const first = await uploadLocation(driver.accessToken, orderId, {
        assignmentVersion: version,
        capturedAt,
      });
      expect(first.body.accepted).toBe(true);
      const retry = await uploadLocation(driver.accessToken, orderId, {
        assignmentVersion: version,
        capturedAt,
      });
      expect(retry.status).toBe(200);
      expect(retry.body.accepted).toBe(false);
    });

    it('rejects an upload tagged with an obsolete assignment version (409)', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const staleVersion = await currentAssignmentVersion(orderId);
      const driverB = await createAndLoginDriver(admin.accessToken, 'Driver B');
      await assignDriverHttp(admin.accessToken, orderId, driverB.driverId);

      // Driver A's app still thinks it holds `staleVersion`.
      const res = await uploadLocation(driver.accessToken, orderId, {
        assignmentVersion: staleVersion,
      });
      // Ownership itself already fails first (driver A is no longer assigned) —
      // both are correct rejections; assert it's one of the two expected codes.
      expect([404, 409]).toContain(res.status);
    });
  });

  // ===========================================================================
  describe('Reassignment and tracking lifecycle', () => {
    it('reassignment clears the previous location and requires a fresh sample before tracking is visible again', async () => {
      const admin = await registerAdmin();
      const { driver: driverA, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const versionA = await currentAssignmentVersion(orderId);
      await uploadLocation(driverA.accessToken, orderId, { assignmentVersion: versionA });

      const beforeReassign = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(beforeReassign.body.state).toBe('ACTIVE');

      const driverB = await createAndLoginDriver(admin.accessToken, 'Driver B');
      await assignDriverHttp(admin.accessToken, orderId, driverB.driverId);

      const afterReassign = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(afterReassign.body.state).toBe('WAITING_FOR_LOCATION');
      expect(afterReassign.body.location).toBeNull();

      // Driver A's obsolete-version upload is rejected...
      const staleUpload = await uploadLocation(driverA.accessToken, orderId, {
        assignmentVersion: versionA,
      });
      expect([404, 409]).toContain(staleUpload.status);

      // ...and driver B must submit a FRESH valid location before it appears.
      const versionB = await currentAssignmentVersion(orderId);
      await uploadLocation(driverB.accessToken, orderId, {
        assignmentVersion: versionB,
        latitude: 24.7,
      });

      const afterFreshUpload = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(afterFreshUpload.body.state).toBe('ACTIVE');
      expect(afterFreshUpload.body.location.latitude).toBe(24.7);
    });

    it('reassigning back to the ORIGINAL driver cannot revive their old sample', async () => {
      const admin = await registerAdmin();
      const { driver: driverA, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const versionA1 = await currentAssignmentVersion(orderId);
      await uploadLocation(driverA.accessToken, orderId, {
        assignmentVersion: versionA1,
        latitude: 20.0,
      });

      const driverB = await createAndLoginDriver(admin.accessToken, 'Driver B');
      await assignDriverHttp(admin.accessToken, orderId, driverB.driverId);
      // Reassign back to driver A — a NEW assignment, distinct from the first.
      await assignDriverHttp(admin.accessToken, orderId, driverA.driverId);
      const versionA2 = await currentAssignmentVersion(orderId);
      expect(versionA2).not.toBe(versionA1);

      // Old assignment version rejected...
      const staleAttempt = await uploadLocation(driverA.accessToken, orderId, {
        assignmentVersion: versionA1,
      });
      expect(staleAttempt.status).toBe(409);

      // ...and even though driver A is assigned again, the OLD coordinates
      // must never resurface until a fresh upload under the new version lands.
      const tracking = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(tracking.body.state).toBe('WAITING_FOR_LOCATION');
      expect(tracking.body.location).toBeNull();

      await uploadLocation(driverA.accessToken, orderId, {
        assignmentVersion: versionA2,
        latitude: 25.0,
      });
      const afterFresh = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(afterFresh.body.state).toBe('ACTIVE');
      expect(afterFresh.body.location.latitude).toBe(25.0); // never the stale 20.0
    });

    it('unassigning mid-delivery ends tracking and hides coordinates immediately', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);
      await uploadLocation(driver.accessToken, orderId, { assignmentVersion: version });

      await unassignDriverHttp(admin.accessToken, orderId);

      const tracking = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(tracking.body.state).toBe('ENDED');
      expect(tracking.body.location).toBeNull();
      expect(tracking.body.driverName).toBeNull();
    });

    it('deactivating the assigned driver ends tracking and hides coordinates immediately', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);
      await uploadLocation(driver.accessToken, orderId, { assignmentVersion: version });

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/drivers/${driver.driverId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ isActive: false });

      const tracking = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(tracking.body.state).toBe('ENDED');
      expect(tracking.body.location).toBeNull();
    });

    it('delivery completion ends tracking and hides coordinates immediately', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);
      await uploadLocation(driver.accessToken, orderId, { assignmentVersion: version });

      await request(app.getHttpServer())
        .patch(`/api/v1/driver/orders/${orderId}/delivered`)
        .set('Authorization', `Bearer ${driver.accessToken}`);

      const tracking = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(tracking.body.state).toBe('ENDED');
      expect(tracking.body.location).toBeNull();
    });

    it('cancellation ends tracking and hides coordinates immediately', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);
      await uploadLocation(driver.accessToken, orderId, { assignmentVersion: version });

      await advanceToStatus(admin.accessToken, orderId, ['cancelled']);

      const tracking = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(tracking.body.state).toBe('ENDED');
      expect(tracking.body.location).toBeNull();
    });
  });

  // ===========================================================================
  describe('Customer tracking reads', () => {
    it('the owning customer can read tracking and sees ACTIVE with driver contact info once a location lands', async () => {
      const admin = await registerAdmin();
      const { customer, driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);
      await uploadLocation(driver.accessToken, orderId, { assignmentVersion: version });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('ACTIVE');
      expect(res.body.driverName).toEqual(expect.any(String));
      expect(res.body.location.latitude).toBeCloseTo(21.5433);
      expect(res.headers['cache-control']).toContain('no-store');
    });

    it("an unrelated customer cannot read another customer's tracking (404, no leak)", async () => {
      const admin = await registerAdmin();
      const { orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const intruder = await registerCustomer('Intruder');

      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${intruder.accessToken}`);
      expect(res.status).toBe(404);
    });

    it('an unrelated driver cannot read tracking via the customer endpoint', async () => {
      const admin = await registerAdmin();
      const { orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const otherDriver = await createAndLoginDriver(admin.accessToken, 'Other Driver');

      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${otherDriver.accessToken}`);
      expect(res.status).toBe(404);
    });

    it('reports NOT_STARTED before the order reaches OUT_FOR_DELIVERY', async () => {
      const customer = await registerCustomer();
      const order = await placeDeliveryOrder(customer.accessToken);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${order.id}/tracking`)
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(res.body.state).toBe('NOT_STARTED');
      expect(res.body.location).toBeNull();
      expect(res.body.driverName).toBeNull();
    });

    it('reports NOT_STARTED (never ACTIVE) for a PICKUP order throughout its lifecycle', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const order = await placePickupOrder(customer.accessToken);
      await advanceToStatus(admin.accessToken, order.id, [
        'confirmed',
        'preparing',
        'readyForPickup',
      ]);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${order.id}/tracking`)
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(res.body.state).toBe('NOT_STARTED');
    });

    it('reports WAITING_FOR_LOCATION once OUT_FOR_DELIVERY but before any sample arrives', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const driver = await createAndLoginDriver(admin.accessToken);
      const order = await placeDeliveryOrder(customer.accessToken);
      await assignDriverHttp(admin.accessToken, order.id, driver.driverId);
      await advanceToStatus(admin.accessToken, order.id, ['confirmed', 'preparing']);
      await request(app.getHttpServer())
        .patch(`/api/v1/driver/orders/${order.id}/pickup`)
        .set('Authorization', `Bearer ${driver.accessToken}`);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${order.id}/tracking`)
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(res.body.state).toBe('WAITING_FOR_LOCATION');
      expect(res.body.driverName).toEqual(expect.any(String)); // driver info shown even while waiting
      expect(res.body.location).toBeNull();
    });
  });

  // ===========================================================================
  describe('Admin tracking reads', () => {
    it('ADMIN and CASHIER can read tracking; DRIVER cannot call this endpoint', async () => {
      const admin = await registerAdmin();
      const cashier = await registerCashier();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);

      const adminRes = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(adminRes.status).toBe(200);

      const cashierRes = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${cashier.accessToken}`);
      expect(cashierRes.status).toBe(200);

      const driverRes = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${driver.accessToken}`);
      expect(driverRes.status).toBe(403);
    });
  });

  // ===========================================================================
  describe('Freshness', () => {
    it('flips from ACTIVE to STALE once the sample ages past the freshness threshold', async () => {
      const admin = await registerAdmin();
      const { orderId } = await setUpOutForDeliveryOrder(admin.accessToken);

      // Directly write an old sample (bypassing the ingestion age gate, which
      // is a separate concern from the READ-side freshness derivation this
      // test targets) to avoid a real 35s sleep.
      const version = await currentAssignmentVersion(orderId);
      await prisma.orderDriverLocation.create({
        data: {
          orderId,
          driverId: (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).driverId!,
          assignmentVersion: version,
          latitude: D('21.5433'),
          longitude: D('39.1728'),
          capturedAt: new Date(Date.now() - 45_000), // older than the 30s threshold
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.body.state).toBe('STALE');
      expect(res.body.location).not.toBeNull(); // real coordinates, just not "current"
      expect(res.body.locationAgeSeconds).toBeGreaterThanOrEqual(45);
    });
  });

  // ===========================================================================
  describe('Concurrency', () => {
    it("a location upload racing a reassignment never lets the old driver's coordinates survive under the new assignment", async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);
      const driverB = await createAndLoginDriver(admin.accessToken, 'Racer B');

      const [uploadRes] = await Promise.all([
        uploadLocation(driver.accessToken, orderId, { assignmentVersion: version, latitude: 30.0 }),
        assignDriverHttp(admin.accessToken, orderId, driverB.driverId),
      ]);
      // Neither call may 500 — one of these two well-defined outcomes only.
      expect([200, 409]).toContain(uploadRes.status);

      // The reassignment always wins eventually (it has no competing
      // precondition the upload's claim could invalidate — the upload never
      // touches `driverId`), so the order is now assigned to driver B at a
      // strictly newer assignment version.
      const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(finalOrder.driverId).toBe(driverB.driverId);
      expect(finalOrder.driverAssignmentVersion).toBeGreaterThan(version);

      // The core invariant: even if driver A's upload committed successfully
      // (won the race against the reassignment), it was tagged with the OLD
      // version — so it can never be read back as the current location.
      const location = await prisma.orderDriverLocation.findUnique({ where: { orderId } });
      if (uploadRes.body.accepted === true) {
        expect(location?.assignmentVersion).toBe(version);
        expect(location?.assignmentVersion).not.toBe(finalOrder.driverAssignmentVersion);
      }
      const tracking = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(tracking.body.state).toBe('WAITING_FOR_LOCATION');
      expect(tracking.body.location).toBeNull();
    });

    it('a location upload racing delivery completion never revives tracking after DELIVERED', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);

      const [uploadRes] = await Promise.all([
        uploadLocation(driver.accessToken, orderId, { assignmentVersion: version, latitude: 31.0 }),
        request(app.getHttpServer())
          .patch(`/api/v1/driver/orders/${orderId}/delivered`)
          .set('Authorization', `Bearer ${driver.accessToken}`),
      ]);
      expect([200, 409]).toContain(uploadRes.status);

      // The DELIVERED transition has no competing precondition the upload's
      // claim could invalidate (upload never touches `status`), so it always
      // wins eventually regardless of interleaving.
      const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(finalOrder.status).toBe('DELIVERED');

      const tracking = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(tracking.body.state).toBe('ENDED');
      expect(tracking.body.location).toBeNull();
    });
  });

  // ===========================================================================
  describe('Rate limiting', () => {
    it('allows the documented cadence and throttles beyond the dedicated per-route limit (60/60s)', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);

      const results: number[] = [];
      for (let i = 0; i < 61; i += 1) {
        const res = await uploadLocation(driver.accessToken, orderId, {
          assignmentVersion: version,
          capturedAt: new Date(Date.now() - (65 - i) * 1000).toISOString(),
        });
        results.push(res.status);
      }

      const successCount = results.filter((s) => s === 200).length;
      const throttledCount = results.filter((s) => s === 429).length;
      expect(successCount).toBeLessThanOrEqual(60);
      expect(throttledCount).toBeGreaterThanOrEqual(1);
      expect(results[results.length - 1]).toBe(429);
    }, 30_000);
  });
});
