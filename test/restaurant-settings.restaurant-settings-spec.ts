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

function weeklyHours(opts: { openTime: string; closeTime: string; isOpen?: boolean } = { openTime: '10:00', closeTime: '02:00' }) {
  return Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    isOpen: opts.isOpen ?? true,
    openTime: opts.isOpen === false ? null : opts.openTime,
    closeTime: opts.isOpen === false ? null : opts.closeTime,
  }));
}

describe('Restaurant Settings & Delivery Zones (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;

  let categoryId: string;
  let checkoutItem: { id: string };
  const cleanupUserIds: string[] = [];
  const cleanupZoneIds: string[] = [];
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
    await prisma.user.update({ where: { id: registered.user.id }, data: { role: role as UserRole } });
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

  async function createZone(admin: string, overrides: Record<string, unknown> = {}) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/delivery-zones')
      .set('Authorization', `Bearer ${admin}`)
      .send({ nameAr: 'منطقة', nameEn: `Zone ${randomUUID().slice(0, 8)}`, deliveryFee: 15, minimumOrder: 0, ...overrides });
    expect(res.status).toBe(201);
    cleanupZoneIds.push(res.body.id);
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

    const settings = await prisma.restaurantSettings.findFirstOrThrow({ where: { singleton: true } });
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
    await prisma.deliveryZone.deleteMany({ where: { id: { in: cleanupZoneIds } } });
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
      };
      const putRes = await request(app.getHttpServer())
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(payload);
      expect(putRes.status).toBe(200);
      expect(putRes.body.restaurantNameEn).toBe('Kebda Zaman Updated');
      expect(putRes.body.logoUrl).toBe('https://example.test/logo.png');

      // Restore immediately so later tests in this file see the baseline.
      await request(app.getHttpServer())
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(originalSettingsPayload);
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
      });
      expect(res.body.id).toBeUndefined();
      expect(res.body.currency).toBeUndefined();
      expect(res.body.updatedAt).toBeUndefined();
    });
  });

  // ===========================================================================
  describe('Delivery zone CRUD authorization', () => {
    it('ADMIN can create/update/delete zones', async () => {
      const admin = await registerWithRole('ADMIN');
      const zone = await createZone(admin.accessToken);

      const patch = await request(app.getHttpServer())
        .patch(`/api/v1/admin/delivery-zones/${zone.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ nameAr: zone.nameAr, nameEn: zone.nameEn, deliveryFee: 20, minimumOrder: 100 });
      expect(patch.status).toBe(200);
      expect(patch.body.deliveryFee).toBe(20);

      const del = await request(app.getHttpServer())
        .delete(`/api/v1/admin/delivery-zones/${zone.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(del.status).toBe(204);
    });

    it('CASHIER and CUSTOMER cannot manage zones', async () => {
      const admin = await registerWithRole('ADMIN');
      const cashier = await registerWithRole('CASHIER');
      const customer = await registerCustomer();
      const zone = await createZone(admin.accessToken);

      for (const token of [cashier.accessToken, customer.accessToken]) {
        const createRes = await request(app.getHttpServer())
          .post('/api/v1/admin/delivery-zones')
          .set('Authorization', `Bearer ${token}`)
          .send({ nameAr: 'x', nameEn: 'x', deliveryFee: 10, minimumOrder: 0 });
        expect(createRes.status).toBe(403);

        const patchRes = await request(app.getHttpServer())
          .patch(`/api/v1/admin/delivery-zones/${zone.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ nameAr: 'x', nameEn: 'x', deliveryFee: 10, minimumOrder: 0 });
        expect(patchRes.status).toBe(403);

        const deleteRes = await request(app.getHttpServer())
          .delete(`/api/v1/admin/delivery-zones/${zone.id}`)
          .set('Authorization', `Bearer ${token}`);
        expect(deleteRes.status).toBe(403);
      }
    });

    it('rejects a negative deliveryFee or minimumOrder with 400', async () => {
      const admin = await registerWithRole('ADMIN');
      const negFee = await request(app.getHttpServer())
        .post('/api/v1/admin/delivery-zones')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ nameAr: 'x', nameEn: 'x', deliveryFee: -1, minimumOrder: 0 });
      expect(negFee.status).toBe(400);

      const negMin = await request(app.getHttpServer())
        .post('/api/v1/admin/delivery-zones')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ nameAr: 'x', nameEn: 'x', deliveryFee: 10, minimumOrder: -1 });
      expect(negMin.status).toBe(400);
    });
  });

  // ===========================================================================
  describe('Public delivery zones endpoint', () => {
    it('returns only active zones, sorted by sortOrder then createdAt', async () => {
      const admin = await registerWithRole('ADMIN');
      const zoneB = await createZone(admin.accessToken, { nameEn: 'Public B', sortOrder: 2 });
      const zoneA = await createZone(admin.accessToken, { nameEn: 'Public A', sortOrder: 1 });
      const inactive = await createZone(admin.accessToken, { nameEn: 'Public Inactive', sortOrder: 0, isActive: false });

      const res = await request(app.getHttpServer()).get('/api/v1/delivery-zones');
      expect(res.status).toBe(200);
      const ids = res.body.map((z: { id: string }) => z.id);
      expect(ids).not.toContain(inactive.id);
      expect(ids.indexOf(zoneA.id)).toBeLessThan(ids.indexOf(zoneB.id));
    });
  });

  // ===========================================================================
  describe('Checkout delivery-zone integration', () => {
    it('rejects DELIVERY checkout without a valid active zone', async () => {
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
      expect(res.body.code).toBe('DELIVERY_ZONE_UNAVAILABLE');
    });

    it('rejects DELIVERY checkout referencing an inactive zone', async () => {
      const admin = await registerWithRole('ADMIN');
      const customer = await registerCustomer();
      const inactiveZone = await createZone(admin.accessToken, { isActive: false });
      await addToCart(customer.accessToken, checkoutItem.id);

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({
          deliveryMethod: 'DELIVERY',
          paymentMethod: 'CASH',
          deliveryAddress: { title: 'Home', street: 'Main St', building: '1', city: 'Cairo' },
          deliveryZoneId: inactiveZone.id,
        });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('DELIVERY_ZONE_UNAVAILABLE');
    });

    it('ignores a client-supplied deliveryFee entirely (unknown field rejected)', async () => {
      const admin = await registerWithRole('ADMIN');
      const customer = await registerCustomer();
      const zone = await createZone(admin.accessToken, { deliveryFee: 33.5 });
      await addToCart(customer.accessToken, checkoutItem.id);

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({
          deliveryMethod: 'DELIVERY',
          paymentMethod: 'CASH',
          deliveryAddress: { title: 'Home', street: 'Main St', building: '1', city: 'Cairo' },
          deliveryZoneId: zone.id,
          deliveryFee: 0.01, // attempted client-supplied price override
        });
      expect(res.status).toBe(400); // forbidNonWhitelisted rejects the extra field outright
    });

    it('uses the selected zone deliveryFee, not the flat settings default', async () => {
      const admin = await registerWithRole('ADMIN');
      const customer = await registerCustomer();
      const zone = await createZone(admin.accessToken, { deliveryFee: 33.5 });
      await addToCart(customer.accessToken, checkoutItem.id);

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({
          deliveryMethod: 'DELIVERY',
          paymentMethod: 'CASH',
          deliveryAddress: { title: 'Home', street: 'Main St', building: '1', city: 'Cairo' },
          deliveryZoneId: zone.id,
        });
      expect(res.status).toBe(201);
      expect(res.body.deliveryFee).toBe(33.5);
      expect(res.body.deliveryZone).toMatchObject({ id: zone.id });
    });

    it('enforces the zone minimum order (MINIMUM_ORDER_NOT_MET)', async () => {
      const admin = await registerWithRole('ADMIN');
      const customer = await registerCustomer();
      const zone = await createZone(admin.accessToken, { minimumOrder: 1000 });
      await addToCart(customer.accessToken, checkoutItem.id);

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({
          deliveryMethod: 'DELIVERY',
          paymentMethod: 'CASH',
          deliveryAddress: { title: 'Home', street: 'Main St', building: '1', city: 'Cairo' },
          deliveryZoneId: zone.id,
        });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('MINIMUM_ORDER_NOT_MET');
      expect(res.body.details?.minimumOrder).toBe(1000);
    });

    it('PICKUP has zero delivery fee, requires no zone, and reports deliveryZone: null', async () => {
      const customer = await registerCustomer();
      await addToCart(customer.accessToken, checkoutItem.id);

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
      expect(res.status).toBe(201);
      expect(res.body.deliveryFee).toBe(0);
      expect(res.body.deliveryZone).toBeNull();
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
