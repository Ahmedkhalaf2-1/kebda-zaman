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
import { GoogleRoutesService } from '../src/modules/delivery-pricing/google-routes.service';

const D = (v: string) => new Prisma.Decimal(v);

const mockGoogleRoutesService = {
  computeRoute: jest.fn().mockResolvedValue({ distanceMeters: 5_000, durationSeconds: 600 }),
};

function weeklyHours(
  opts: { openTime: string; closeTime: string; isOpen?: boolean } = {
    openTime: '10:00',
    closeTime: '02:00',
  },
) {
  return Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    isOpen: opts.isOpen ?? true,
    openTime: opts.isOpen === false ? null : opts.openTime,
    closeTime: opts.isOpen === false ? null : opts.closeTime,
  }));
}

describe('Restaurant Settings & Distance-Based Delivery Pricing (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;

  let categoryId: string;
  let checkoutItem: { id: string };
  const cleanupUserIds: string[] = [];
  const cleanupTierIds: string[] = [];
  let originalSettingsPayload: Record<string, unknown>;

  async function registerCustomer() {
    const registered = await authService.register(
      {
        name: 'RS Customer',
        email: `rs-customer-${randomUUID()}@phase8.local`,
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
        name: `RS ${role}`,
        email: `rs-${role.toLowerCase()}-${randomUUID()}@phase8.local`,
        password: 'correcthorsebattery',
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    await prisma.user.update({
      where: { id: registered.user.id },
      data: { role: role as UserRole },
    });
    return authService.login(
      { email: registered.user.email as string, password: 'correcthorsebattery' },
      {},
    );
  }

  async function addToCart(accessToken: string, menuItemId: string, quantity = 1) {
    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ menuItemId, quantity });
  }

  /** Defaults to a far-away, inactive range so it never collides with the 3
   * seeded production tiers' 0-30km active coverage — pass isActive: true
   * with an explicit non-overlapping range for coverage-specific tests. */
  async function createTier(admin: string, overrides: Record<string, unknown> = {}) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/delivery-tiers')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        minDistanceKm: 100,
        maxDistanceKm: 110,
        deliveryFee: 15,
        isActive: false,
        ...overrides,
      });
    expect(res.status).toBe(201);
    cleanupTierIds.push(res.body.id);
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

    const category = await prisma.category.create({
      data: { nameAr: 'فئة الإعدادات', nameEn: 'Phase 8 Settings Category' },
    });
    categoryId = category.id;
    checkoutItem = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف',
        nameEn: 'Settings Checkout Item',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: D('60.00'),
      },
    });

    const settings = await prisma.restaurantSettings.findFirstOrThrow({
      where: { singleton: true },
    });
    originalSettingsPayload = {
      restaurantNameAr: settings.restaurantNameAr,
      restaurantNameEn: settings.restaurantNameEn,
      logoUrl: settings.logoUrl,
      phone: settings.phone,
      addressAr: settings.addressAr,
      addressEn: settings.addressEn,
      taxRatePercent: settings.taxRatePercent.toNumber(),
      deliveryFee: settings.deliveryFee.toNumber(),
      minOrderAmount: settings.minOrderAmount.toNumber(),
      currency: settings.currency,
      workingHours: settings.workingHours,
      timezone: settings.timezone,
      isMaintenanceMode: settings.isMaintenanceMode,
      acceptingOrders: settings.acceptingOrders,
      closedMessageAr: settings.closedMessageAr,
      closedMessageEn: settings.closedMessageEn,
      restaurantLatitude: settings.restaurantLatitude.toNumber(),
      restaurantLongitude: settings.restaurantLongitude.toNumber(),
    };
  });

  afterAll(async () => {
    // Restore the shared singleton so other suites see the original baseline.
    await prisma.restaurantSettings.update({
      where: { singleton: true },
      data: originalSettingsPayload,
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
    await prisma.deliveryDistanceTier.deleteMany({ where: { id: { in: cleanupTierIds } } });
    await prisma.menuItem.deleteMany({ where: { categoryId } });
    await prisma.category.delete({ where: { id: categoryId } });
    await app.close();
  });

  // ===========================================================================
  describe('Admin restaurant settings', () => {
    it('ADMIN can read and update settings', async () => {
      const admin = await registerWithRole('ADMIN');
      const getRes = await request(app.getHttpServer())
        .get('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(getRes.status).toBe(200);

      const payload = {
        ...originalSettingsPayload,
        restaurantNameAr: 'كبدة زمان محدث',
        restaurantNameEn: 'Kebda Zaman Updated',
        logoUrl: 'https://example.test/logo.png',
        acceptingOrders: true,
        workingHours: weeklyHours({ openTime: '09:00', closeTime: '23:00' }),
        restaurantLatitude: 21.6,
        restaurantLongitude: 39.2,
      };
      const putRes = await request(app.getHttpServer())
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(payload);
      expect(putRes.status).toBe(200);
      expect(putRes.body.restaurantNameEn).toBe('Kebda Zaman Updated');
      expect(putRes.body.logoUrl).toBe('https://example.test/logo.png');
      expect(putRes.body.restaurantLatitude).toBe(21.6);
      expect(putRes.body.restaurantLongitude).toBe(39.2);

      // Restore immediately so later tests in this file see the baseline.
      await request(app.getHttpServer())
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(originalSettingsPayload);
    });

    it('rejects an out-of-range restaurant latitude/longitude with 400', async () => {
      const admin = await registerWithRole('ADMIN');
      const res = await request(app.getHttpServer())
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ...originalSettingsPayload, restaurantLatitude: 999, restaurantLongitude: 39.2 });
      expect(res.status).toBe(400);
    });

    it('CASHIER and CUSTOMER cannot modify settings', async () => {
      const cashier = await registerWithRole('CASHIER');
      const customer = await registerCustomer();
      for (const token of [cashier.accessToken, customer.accessToken]) {
        const res = await request(app.getHttpServer())
          .put('/api/v1/admin/settings')
          .set('Authorization', `Bearer ${token}`)
          .send(originalSettingsPayload);
        expect(res.status).toBe(403);
      }
    });

    it('public settings expose only safe fields', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/settings');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        restaurantNameAr: expect.any(String),
        restaurantNameEn: expect.any(String),
        addressAr: expect.any(String),
        addressEn: expect.any(String),
        phone: expect.any(String),
        deliveryFee: expect.any(Number),
        taxRatePercent: expect.any(Number),
        minOrderAmount: expect.any(Number),
        acceptingOrders: expect.any(Boolean),
        timezone: expect.any(String),
        restaurantLatitude: expect.any(Number),
        restaurantLongitude: expect.any(Number),
      });
      expect(res.body.id).toBeUndefined();
      expect(res.body.currency).toBeUndefined();
      expect(res.body.updatedAt).toBeUndefined();
    });
  });

  // ===========================================================================
  describe('Admin delivery-tier CRUD authorization', () => {
    it('ADMIN can create/update tiers, including activate/deactivate via the same DTO', async () => {
      const admin = await registerWithRole('ADMIN');
      const tier = await createTier(admin.accessToken);

      const patch = await request(app.getHttpServer())
        .patch(`/api/v1/admin/delivery-tiers/${tier.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ minDistanceKm: 100, maxDistanceKm: 110, deliveryFee: 20, isActive: false });
      expect(patch.status).toBe(200);
      expect(patch.body.deliveryFee).toBe('20.00');
      expect(patch.body.isActive).toBe(false);

      const list = await request(app.getHttpServer())
        .get('/api/v1/admin/delivery-tiers')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(list.status).toBe(200);
      expect(list.body.some((t: { id: string }) => t.id === tier.id)).toBe(true);
    });

    it('CASHIER and CUSTOMER cannot manage tiers', async () => {
      const admin = await registerWithRole('ADMIN');
      const cashier = await registerWithRole('CASHIER');
      const customer = await registerCustomer();
      const tier = await createTier(admin.accessToken);

      for (const token of [cashier.accessToken, customer.accessToken]) {
        const createRes = await request(app.getHttpServer())
          .post('/api/v1/admin/delivery-tiers')
          .set('Authorization', `Bearer ${token}`)
          .send({ minDistanceKm: 200, maxDistanceKm: 210, deliveryFee: 10, isActive: false });
        expect(createRes.status).toBe(403);

        const patchRes = await request(app.getHttpServer())
          .patch(`/api/v1/admin/delivery-tiers/${tier.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ minDistanceKm: 100, maxDistanceKm: 110, deliveryFee: 10, isActive: false });
        expect(patchRes.status).toBe(403);

        const listRes = await request(app.getHttpServer())
          .get('/api/v1/admin/delivery-tiers')
          .set('Authorization', `Bearer ${token}`);
        expect(listRes.status).toBe(403);
      }
    });

    it('rejects a negative deliveryFee or an inverted range with 400/422', async () => {
      const admin = await registerWithRole('ADMIN');
      const negFee = await request(app.getHttpServer())
        .post('/api/v1/admin/delivery-tiers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ minDistanceKm: 100, maxDistanceKm: 110, deliveryFee: -1, isActive: false });
      expect(negFee.status).toBe(400);

      const inverted = await request(app.getHttpServer())
        .post('/api/v1/admin/delivery-tiers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ minDistanceKm: 110, maxDistanceKm: 100, deliveryFee: 10, isActive: false });
      expect(inverted.status).toBe(422);
      expect(inverted.body.code).toBe('DELIVERY_TIER_INVALID_RANGE');
    });

    it('rejects an active tier that overlaps the seeded 0-30km coverage', async () => {
      const admin = await registerWithRole('ADMIN');
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/delivery-tiers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ minDistanceKm: 10, maxDistanceKm: 20, deliveryFee: 10, isActive: true });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('DELIVERY_TIER_OVERLAP');
    });
  });

  // ===========================================================================
  describe('Checkout delivery-pricing integration', () => {
    it('rejects DELIVERY checkout without coordinates (DELIVERY_COORDINATES_REQUIRED)', async () => {
      const customer = await registerCustomer();
      await addToCart(customer.accessToken, checkoutItem.id);

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({
          deliveryMethod: 'DELIVERY',
          paymentMethod: 'CASH',
          deliveryAddress: { title: 'Home', street: 'Main St', building: '1', city: 'Cairo' },
        });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('DELIVERY_COORDINATES_REQUIRED');
    });

    it('rejects a destination beyond 30km (OUTSIDE_DELIVERY_RANGE)', async () => {
      mockGoogleRoutesService.computeRoute.mockResolvedValueOnce({
        distanceMeters: 30_001,
        durationSeconds: 2400,
      });
      const customer = await registerCustomer();
      await addToCart(customer.accessToken, checkoutItem.id);

      const res = await request(app.getHttpServer())
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
            latitude: 21.6,
            longitude: 39.2,
          },
        });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('OUTSIDE_DELIVERY_RANGE');
    });

    it('ignores a client-supplied deliveryFee entirely (unknown field rejected)', async () => {
      const customer = await registerCustomer();
      await addToCart(customer.accessToken, checkoutItem.id);

      const res = await request(app.getHttpServer())
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
            latitude: 21.6,
            longitude: 39.2,
          },
          deliveryFee: 0.01, // attempted client-supplied price override
        });
      expect(res.status).toBe(400); // forbidNonWhitelisted rejects the extra field outright
    });

    // Exact boundary behavior required by VO3: 14999m/24999m/30000m stay in
    // the lower tier, 15000m/25000m cross into the next, 30001m is rejected.
    it.each([
      [0, '10.00', '0.00', '15.00'],
      [14_999, '10.00', '0.00', '15.00'],
      [15_000, '15.00', '15.00', '25.00'],
      [24_999, '15.00', '15.00', '25.00'],
      [25_000, '25.00', '25.00', '30.00'],
      [30_000, '25.00', '25.00', '30.00'],
    ])(
      'at %i meters, charges %s SAR (tier %s-%s km)',
      async (distanceMeters, expectedFee, expectedMin, expectedMax) => {
        mockGoogleRoutesService.computeRoute.mockResolvedValueOnce({
          distanceMeters,
          durationSeconds: 600,
        });
        const customer = await registerCustomer();
        await addToCart(customer.accessToken, checkoutItem.id);

        const res = await request(app.getHttpServer())
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
              latitude: 21.6,
              longitude: 39.2,
            },
          });
        expect(res.status).toBe(201);
        expect(res.body.deliveryFee).toBe(Number(expectedFee));
        expect(res.body.deliveryTier).toMatchObject({
          minDistanceKm: expectedMin,
          maxDistanceKm: expectedMax,
        });
        expect(res.body.deliveryDistanceMeters).toBe(distanceMeters);
      },
    );

    it('enforces a tier-specific minimum order (MINIMUM_ORDER_NOT_MET) when an admin configures one', async () => {
      const admin = await registerWithRole('ADMIN');
      const list = await request(app.getHttpServer())
        .get('/api/v1/admin/delivery-tiers')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      const firstTier = list.body.find(
        (t: { minDistanceKm: string }) => t.minDistanceKm === '0.00',
      );

      // Temporarily give the first tier a minimum order, then restore it —
      // the approved production tiers ship with minimumOrder: 0.
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/delivery-tiers/${firstTier.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          minDistanceKm: 0,
          maxDistanceKm: 15,
          deliveryFee: 10,
          minimumOrder: 1000,
          isActive: true,
        });

      try {
        mockGoogleRoutesService.computeRoute.mockResolvedValueOnce({
          distanceMeters: 5_000,
          durationSeconds: 600,
        });
        const customer = await registerCustomer();
        await addToCart(customer.accessToken, checkoutItem.id);

        const res = await request(app.getHttpServer())
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
              latitude: 21.6,
              longitude: 39.2,
            },
          });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('MINIMUM_ORDER_NOT_MET');
        expect(res.body.details?.minimumOrder).toBe(1000);
      } finally {
        await request(app.getHttpServer())
          .patch(`/api/v1/admin/delivery-tiers/${firstTier.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send({
            minDistanceKm: 0,
            maxDistanceKm: 15,
            deliveryFee: 10,
            minimumOrder: 0,
            isActive: true,
          });
      }
    });

    it('PICKUP has zero delivery fee, never calls Google Routes, and reports deliveryTier: null', async () => {
      mockGoogleRoutesService.computeRoute.mockClear();
      const customer = await registerCustomer();
      await addToCart(customer.accessToken, checkoutItem.id);

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
      expect(res.status).toBe(201);
      expect(res.body.deliveryFee).toBe(0);
      expect(res.body.deliveryTier).toBeNull();
      expect(res.body.deliveryDistanceMeters).toBeNull();
      expect(mockGoogleRoutesService.computeRoute).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  describe('Order acceptance state', () => {
    it('rejects new checkout with RESTAURANT_NOT_ACCEPTING_ORDERS while closed, and cart/menu stay reachable', async () => {
      const admin = await registerWithRole('ADMIN');
      const customer = await registerCustomer();
      await addToCart(customer.accessToken, checkoutItem.id);

      await request(app.getHttpServer())
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          ...originalSettingsPayload,
          acceptingOrders: false,
          closedMessageAr: 'مغلق الآن',
          closedMessageEn: 'Currently closed',
        });

      try {
        const cartRes = await request(app.getHttpServer())
          .get('/api/v1/cart')
          .set('Authorization', `Bearer ${customer.accessToken}`);
        expect(cartRes.status).toBe(200);

        const menuRes = await request(app.getHttpServer()).get('/api/v1/menu');
        expect(menuRes.status).toBe(200);

        const checkoutRes = await request(app.getHttpServer())
          .post('/api/v1/checkout')
          .set('Authorization', `Bearer ${customer.accessToken}`)
          .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
        expect(checkoutRes.status).toBe(422);
        expect(checkoutRes.body.code).toBe('RESTAURANT_NOT_ACCEPTING_ORDERS');
      } finally {
        await request(app.getHttpServer())
          .put('/api/v1/admin/settings')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(originalSettingsPayload);
      }
    });
  });
});
