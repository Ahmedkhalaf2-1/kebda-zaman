// This suite creates several drivers/orders/customers per test — same
// rationale as the other driver-*-spec.ts files: raise the global throttle
// for this process only, never touching the real .env default.
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

/**
 * Issues the EXACT same conditional `INSERT ... ON CONFLICT ... DO UPDATE
 * ... WHERE` statement `DriverLocationService.recordLocation` uses for its
 * write — with one addition: a `pg_sleep($delaySeconds)` evaluated as part
 * of the INSERT's source query, via a CTE. This lets a test deterministically
 * control which of two genuinely concurrent writes reaches the conflict-
 * resolution step first, independent of which one was issued first in JS —
 * proving the WHERE guard (not incidental call ordering) decides the
 * outcome. Each call is its own implicit single-statement transaction
 * (Postgres auto-commits a lone statement), so firing two of these via
 * `Promise.all` produces TRUE overlapping execution at the database level,
 * not just overlapping JS Promises that might resolve sequentially anyway.
 */
async function rawConditionalUpsert(
  prisma: PrismaService,
  params: {
    orderId: string;
    driverId: string;
    assignmentVersion: number;
    latitude: number;
    capturedAt: Date;
    receivedAt: Date;
    delaySeconds?: number;
  },
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ accepted: boolean }>>(Prisma.sql`
    WITH delay AS (SELECT pg_sleep(${params.delaySeconds ?? 0}))
    INSERT INTO "OrderDriverLocation"
      ("orderId", "driverId", "assignmentVersion", "latitude", "longitude",
       "accuracyMeters", "headingDegrees", "speedMps", "capturedAt", "receivedAt", "updatedAt")
    SELECT ${params.orderId}::uuid, ${params.driverId}::uuid, ${params.assignmentVersion},
           ${params.latitude}, ${39.1728}, NULL, NULL, NULL,
           ${params.capturedAt}, ${params.receivedAt}, ${params.receivedAt}
    FROM delay
    ON CONFLICT ("orderId") DO UPDATE SET
      "driverId" = EXCLUDED."driverId",
      "assignmentVersion" = EXCLUDED."assignmentVersion",
      "latitude" = EXCLUDED."latitude",
      "longitude" = EXCLUDED."longitude",
      "accuracyMeters" = EXCLUDED."accuracyMeters",
      "headingDegrees" = EXCLUDED."headingDegrees",
      "speedMps" = EXCLUDED."speedMps",
      "capturedAt" = EXCLUDED."capturedAt",
      "receivedAt" = EXCLUDED."receivedAt",
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE
      "OrderDriverLocation"."assignmentVersion" < EXCLUDED."assignmentVersion"
      OR (
        "OrderDriverLocation"."assignmentVersion" = EXCLUDED."assignmentVersion"
        AND "OrderDriverLocation"."capturedAt" < EXCLUDED."capturedAt"
      )
    RETURNING true AS accepted
  `);
  return rows.length === 1;
}

/**
 * Gates the FIRST of two calls to `prisma.$transaction` until the SECOND
 * call has itself been invoked — same technique/intent as
 * `gateFirstOfTwoOrderReads` in test/admin-orders.admin-orders-spec.ts,
 * adapted to the transaction boundary itself (rather than a preceding read)
 * since the code under test here has no separate pre-transaction read to
 * gate. Guarantees both operations are genuinely "in flight" concurrently
 * before either one's claim executes, rather than risking an accidentally
 * fully-sequential (and therefore race-free-by-accident) execution.
 */
function gateFirstOfTwoTransactions(prisma: PrismaService): { restore: () => void } {
  const original = prisma.$transaction.bind(prisma);
  let callCount = 0;
  let releaseFirstCall: () => void = () => undefined;
  const secondCallStarted = new Promise<void>((resolve) => {
    releaseFirstCall = resolve;
  });
  const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => {
    return (async () => {
      callCount += 1;
      if (callCount === 1) {
        await secondCallStarted;
      } else if (callCount === 2) {
        releaseFirstCall();
      }

      return (original as any)(...args);
    })();
  }) as typeof prisma.$transaction);
  return { restore: () => spy.mockRestore() };
}

describe('Driver location — concurrent write ordering (Phase 2 race fix)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;

  let categoryId: string;
  let checkoutItem: { id: string };
  const cleanupUserIds: string[] = [];

  async function registerCustomer() {
    const registered = await authService.register(
      {
        name: 'Race Customer',
        email: `race-customer-${randomUUID()}@phase-race.local`,
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
        name: 'Race Admin',
        email: `race-admin-${randomUUID()}@phase-race.local`,
        password: PASSWORD,
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    await prisma.user.update({ where: { id: registered.user.id }, data: { role: 'ADMIN' } });
    return authService.login({ email: registered.user.email as string, password: PASSWORD }, {});
  }

  async function createAndLoginDriver(adminToken: string, name = 'Race Driver') {
    const email = `race-driver-${randomUUID()}@phase-race.local`;
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/admin/drivers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name, email, password: PASSWORD, phone: '0500000001' });
    expect(createRes.status).toBe(201);
    cleanupUserIds.push(createRes.body.id);
    const tokens = await authService.login({ email, password: PASSWORD }, {});
    return { driverId: createRes.body.id as string, accessToken: tokens.accessToken };
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
  }

  /** Sets up a DELIVERY order all the way to OUT_FOR_DELIVERY, assigned to a
   * fresh driver — no location uploaded yet. */
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
      data: { nameAr: 'فئة السباق', nameEn: 'Race Spec Category' },
    });
    categoryId = category.id;
    checkoutItem = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف',
        nameEn: 'Race Spec Item',
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
  describe('1. Concurrent newer and older samples against an EXISTING row', () => {
    it('the older sample loses even when its write reaches the database AFTER the newer one has already committed', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);
      const now = new Date();
      const older = new Date(now.getTime() - 30_000);
      const newer = new Date(now.getTime() - 5_000);

      // The OLDER sample is issued with a 0.4s DB-side delay; the NEWER
      // sample has none — forcing the newer write to commit FIRST despite
      // being fired concurrently, regardless of JS scheduling.
      const [olderAccepted, newerAccepted] = await Promise.all([
        rawConditionalUpsert(prisma, {
          orderId,
          driverId: driver.driverId,
          assignmentVersion: version,
          latitude: 10.0,
          capturedAt: older,
          receivedAt: now,
          delaySeconds: 0.4,
        }),
        rawConditionalUpsert(prisma, {
          orderId,
          driverId: driver.driverId,
          assignmentVersion: version,
          latitude: 20.0,
          capturedAt: newer,
          receivedAt: now,
        }),
      ]);

      expect(newerAccepted).toBe(true);
      expect(olderAccepted).toBe(false); // arrived at the DB LAST, but must still lose

      const finalRow = await prisma.orderDriverLocation.findUniqueOrThrow({ where: { orderId } });
      expect(finalRow.latitude.toNumber()).toBe(20.0);
      expect(finalRow.capturedAt.getTime()).toBe(newer.getTime());
      expect(finalRow.assignmentVersion).toBe(version);
    });

    it('the newer sample wins even when its write reaches the database AFTER the older one has already committed', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);
      const now = new Date();
      const older = new Date(now.getTime() - 30_000);
      const newer = new Date(now.getTime() - 5_000);

      // This time the NEWER sample is delayed — proving the outcome depends
      // on the VALUE, not "whichever call happens to finish first."
      const [olderAccepted, newerAccepted] = await Promise.all([
        rawConditionalUpsert(prisma, {
          orderId,
          driverId: driver.driverId,
          assignmentVersion: version,
          latitude: 10.0,
          capturedAt: older,
          receivedAt: now,
        }),
        rawConditionalUpsert(prisma, {
          orderId,
          driverId: driver.driverId,
          assignmentVersion: version,
          latitude: 20.0,
          capturedAt: newer,
          receivedAt: now,
          delaySeconds: 0.4,
        }),
      ]);

      expect(olderAccepted).toBe(true); // wins the initial insert (no row existed yet)
      expect(newerAccepted).toBe(true); // then correctly supersedes it

      const finalRow = await prisma.orderDriverLocation.findUniqueOrThrow({ where: { orderId } });
      expect(finalRow.latitude.toNumber()).toBe(20.0);
      expect(finalRow.capturedAt.getTime()).toBe(newer.getTime());
    });
  });

  // ===========================================================================
  describe('2. Concurrent FIRST uploads — no location row exists yet', () => {
    it('two genuinely concurrent first-ever samples never both "win", and the correct (newer) one persists', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);
      const now = new Date();
      const earlierFix = new Date(now.getTime() - 20_000);
      const laterFix = new Date(now.getTime() - 2_000);

      // No pg_sleep needed to prove safety here — Postgres's own
      // INSERT..ON CONFLICT conflict handling is what's under test: fire
      // both at the literal same instant against a row that does not exist.
      const results = await Promise.all([
        rawConditionalUpsert(prisma, {
          orderId,
          driverId: driver.driverId,
          assignmentVersion: version,
          latitude: 1.0,
          capturedAt: earlierFix,
          receivedAt: now,
        }),
        rawConditionalUpsert(prisma, {
          orderId,
          driverId: driver.driverId,
          assignmentVersion: version,
          latitude: 2.0,
          capturedAt: laterFix,
          receivedAt: now,
        }),
      ]);

      // Exactly one row exists afterward (no duplicate-row/crash), and it
      // reflects the NEWER of the two fixes regardless of which INSERT won
      // the race to create the row first.
      expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(1);
      const finalRow = await prisma.orderDriverLocation.findUniqueOrThrow({ where: { orderId } });
      expect(finalRow.latitude.toNumber()).toBe(2.0);
      expect(finalRow.capturedAt.getTime()).toBe(laterFix.getTime());
    });
  });

  // ===========================================================================
  describe('3. Equal timestamps and exact duplicate retries', () => {
    it('an exact-duplicate retry does not refresh receivedAt or otherwise change the stored row', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);

      const capturedAt = new Date(Date.now() - 5_000).toISOString();
      const first = await uploadLocation(driver.accessToken, orderId, {
        assignmentVersion: version,
        capturedAt,
      });
      expect(first.body.accepted).toBe(true);
      const afterFirst = await prisma.orderDriverLocation.findUniqueOrThrow({ where: { orderId } });

      // Real delay so a bug that DID refresh receivedAt would be caught.
      await new Promise((r) => setTimeout(r, 50));
      const retry = await uploadLocation(driver.accessToken, orderId, {
        assignmentVersion: version,
        capturedAt, // exact same capturedAt as the accepted sample — a retry
      });
      expect(retry.status).toBe(200);
      expect(retry.body.accepted).toBe(false);

      const afterRetry = await prisma.orderDriverLocation.findUniqueOrThrow({ where: { orderId } });
      expect(afterRetry.receivedAt.getTime()).toBe(afterFirst.receivedAt.getTime());
      expect(afterRetry.capturedAt.getTime()).toBe(afterFirst.capturedAt.getTime());
      expect(afterRetry.latitude.toNumber()).toBe(afterFirst.latitude.toNumber());
    });

    it('two equal-timestamp samples deterministically keep the first-arrived one (tie goes to whoever committed first)', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);
      const tie = new Date(Date.now() - 10_000);
      const now = new Date();

      const firstAccepted = await rawConditionalUpsert(prisma, {
        orderId,
        driverId: driver.driverId,
        assignmentVersion: version,
        latitude: 5.0,
        capturedAt: tie,
        receivedAt: now,
      });
      expect(firstAccepted).toBe(true);

      // Same exact capturedAt, different coordinates — must be rejected.
      const secondAccepted = await rawConditionalUpsert(prisma, {
        orderId,
        driverId: driver.driverId,
        assignmentVersion: version,
        latitude: 6.0,
        capturedAt: tie,
        receivedAt: new Date(),
      });
      expect(secondAccepted).toBe(false);

      const finalRow = await prisma.orderDriverLocation.findUniqueOrThrow({ where: { orderId } });
      expect(finalRow.latitude.toNumber()).toBe(5.0); // the first-committed one, untouched
    });
  });

  // ===========================================================================
  describe('4. Upload racing reassignment — forced genuine overlap', () => {
    it('regardless of which of the two claims reaches the database first, an old assignment never leaves its coordinates visible under the new one', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);
      const driverB = await createAndLoginDriver(admin.accessToken, 'Racer B');

      const gate = gateFirstOfTwoTransactions(prisma);
      try {
        const [uploadRes] = await Promise.all([
          uploadLocation(driver.accessToken, orderId, {
            assignmentVersion: version,
            latitude: 30.0,
          }),
          assignDriverHttp(admin.accessToken, orderId, driverB.driverId),
        ]);
        expect([200, 409]).toContain(uploadRes.status);
      } finally {
        gate.restore();
      }

      const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(finalOrder.driverId).toBe(driverB.driverId);
      expect(finalOrder.driverAssignmentVersion).toBeGreaterThan(version);

      const location = await prisma.orderDriverLocation.findUnique({ where: { orderId } });
      // If the upload's write DID land, it must be tagged with the OLD
      // version — never the new one — so it can never be read as current.
      if (location) {
        expect(location.assignmentVersion).toBeLessThan(finalOrder.driverAssignmentVersion);
      }

      const tracking = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(tracking.body.state).toBe('WAITING_FOR_LOCATION');
      expect(tracking.body.location).toBeNull();
    });
  });

  // ===========================================================================
  describe('5. Upload racing delivery completion — forced genuine overlap', () => {
    it('regardless of which claim reaches the database first, DELIVERED always ends tracking with no coordinates', async () => {
      const admin = await registerAdmin();
      const { driver, orderId } = await setUpOutForDeliveryOrder(admin.accessToken);
      const version = await currentAssignmentVersion(orderId);

      const gate = gateFirstOfTwoTransactions(prisma);
      try {
        const [uploadRes] = await Promise.all([
          uploadLocation(driver.accessToken, orderId, {
            assignmentVersion: version,
            latitude: 31.0,
          }),
          request(app.getHttpServer())
            .patch(`/api/v1/driver/orders/${orderId}/delivered`)
            .set('Authorization', `Bearer ${driver.accessToken}`),
        ]);
        expect([200, 409]).toContain(uploadRes.status);
      } finally {
        gate.restore();
      }

      const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(finalOrder.status).toBe('DELIVERED');

      const tracking = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/tracking`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(tracking.body.state).toBe('ENDED');
      expect(tracking.body.location).toBeNull();
    });
  });
});
