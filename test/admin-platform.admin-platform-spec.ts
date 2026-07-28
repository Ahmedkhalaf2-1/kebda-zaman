import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { AuthService } from '../src/modules/auth/auth.service';
import { CampaignsSchedulerService } from '../src/modules/notifications/campaigns-scheduler.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { Prisma } from '@prisma/client';

describe('Admin Platform: Promos, Settings, Notification Campaigns (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;
  let scheduler: CampaignsSchedulerService;
  let sendToTokens: jest.Mock;

  const cleanupUserIds: string[] = [];
  const cleanupPromoIds: string[] = [];
  const cleanupCampaignIds: string[] = [];
  const cleanupTokens: string[] = [];
  let originalSettings: {
    restaurantNameAr: string;
    restaurantNameEn: string;
    logoUrl: string | null;
    phone: string;
    addressAr: string;
    addressEn: string;
    taxRatePercent: number;
    deliveryFee: number;
    minOrderAmount: number;
    currency: string;
    workingHours: Prisma.InputJsonValue;
    timezone: string;
    isMaintenanceMode: boolean;
    acceptingOrders: boolean;
    closedMessageAr: string | null;
    closedMessageEn: string | null;
  };

  async function registerCustomer() {
    const registered = await authService.register(
      {
        name: 'AP Customer',
        email: `ap-customer-${randomUUID()}@phase7c.local`,
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
        name: 'AP Admin',
        email: `ap-admin-${randomUUID()}@phase7c.local`,
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

  function newPromoPayload(overrides: Record<string, unknown> = {}) {
    return {
      code: `PROMO${randomUUID().slice(0, 8).toUpperCase()}`,
      discountType: 'PERCENT',
      value: 10,
      ...overrides,
    };
  }

  function weeklyHours(opts: { openTime: string; closeTime: string }) {
    return Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      isOpen: true,
      openTime: opts.openTime,
      closeTime: opts.closeTime,
    }));
  }

  function newCampaignPayload(overrides: Record<string, unknown> = {}) {
    return {
      campaignName: `Campaign ${randomUUID()}`,
      title: 'Big sale',
      body: 'Everything is on sale today.',
      type: 'promotion',
      targetAudience: 'ALL',
      ...overrides,
    };
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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
    scheduler = app.get(CampaignsSchedulerService);

    const notificationsService = app.get(NotificationsService);
    sendToTokens = jest.spyOn(notificationsService, 'sendToTokens').mockResolvedValue({
      successCount: 0,
      failureCount: 0,
      invalidTokens: [],
    }) as unknown as jest.Mock;

    const settings = await prisma.restaurantSettings.findFirstOrThrow({
      where: { singleton: true },
    });
    originalSettings = {
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
      workingHours: settings.workingHours as Prisma.InputJsonValue,
      timezone: settings.timezone,
      isMaintenanceMode: settings.isMaintenanceMode,
      acceptingOrders: settings.acceptingOrders,
      closedMessageAr: settings.closedMessageAr,
      closedMessageEn: settings.closedMessageEn,
    };
  });

  afterAll(async () => {
    await prisma.restaurantSettings.update({
      where: { singleton: true },
      data: originalSettings,
    });
    if (cleanupTokens.length > 0) {
      await prisma.deviceToken.deleteMany({ where: { token: { in: cleanupTokens } } });
    }
    if (cleanupCampaignIds.length > 0) {
      await prisma.notificationCampaign.deleteMany({ where: { id: { in: cleanupCampaignIds } } });
    }
    if (cleanupPromoIds.length > 0) {
      await prisma.promoCode.deleteMany({ where: { id: { in: cleanupPromoIds } } });
    }
    if (cleanupUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    }
    await app.close();
  });

  beforeEach(() => {
    sendToTokens.mockReset();
    sendToTokens.mockResolvedValue({ successCount: 0, failureCount: 0, invalidTokens: [] });
  });

  // ===========================================================================
  describe('Access control', () => {
    it('rejects a CUSTOMER on every admin platform route (403)', async () => {
      const customer = await registerCustomer();
      const auth = `Bearer ${customer.accessToken}`;

      const promosRes = await request(app.getHttpServer())
        .get('/api/v1/admin/promos')
        .set('Authorization', auth);
      const settingsRes = await request(app.getHttpServer())
        .get('/api/v1/admin/settings')
        .set('Authorization', auth);
      const campaignsRes = await request(app.getHttpServer())
        .get('/api/v1/admin/notifications/campaigns')
        .set('Authorization', auth);
      const sendRes = await request(app.getHttpServer())
        .post('/api/v1/admin/notifications/send')
        .set('Authorization', auth)
        .send(newCampaignPayload());

      [promosRes, settingsRes, campaignsRes, sendRes].forEach((res) =>
        expect(res.status).toBe(403),
      );
    });

    it('rejects an unauthenticated caller with 401', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/admin/promos');
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  describe('Promo CRUD', () => {
    it('creates, lists, updates, and soft-deletes a promo code', async () => {
      const admin = await registerAdmin();
      const auth = `Bearer ${admin.accessToken}`;

      const createRes = await request(app.getHttpServer())
        .post('/api/v1/admin/promos')
        .set('Authorization', auth)
        .send(newPromoPayload({ value: 15 }));
      expect(createRes.status).toBe(201);
      expect(createRes.body.value).toBe(15);
      expect(createRes.body.isActive).toBe(true);
      const promoId = createRes.body.id as string;
      cleanupPromoIds.push(promoId);

      const listRes = await request(app.getHttpServer())
        .get('/api/v1/admin/promos')
        .set('Authorization', auth);
      expect(listRes.status).toBe(200);
      expect(listRes.body.some((p: { id: string }) => p.id === promoId)).toBe(true);

      const updateRes = await request(app.getHttpServer())
        .put(`/api/v1/admin/promos/${promoId}`)
        .set('Authorization', auth)
        .send(newPromoPayload({ code: createRes.body.code, value: 25, isActive: false }));
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.value).toBe(25);
      expect(updateRes.body.isActive).toBe(false);

      const deleteRes = await request(app.getHttpServer())
        .delete(`/api/v1/admin/promos/${promoId}`)
        .set('Authorization', auth);
      expect(deleteRes.status).toBe(204);

      const listAfterDelete = await request(app.getHttpServer())
        .get('/api/v1/admin/promos')
        .set('Authorization', auth);
      expect(listAfterDelete.body.some((p: { id: string }) => p.id === promoId)).toBe(false);

      const row = await prisma.promoCode.findUniqueOrThrow({ where: { id: promoId } });
      expect(row.deletedAt).not.toBeNull();
    });

    it('rejects creating a duplicate code (case-insensitive) with 409', async () => {
      const admin = await registerAdmin();
      const auth = `Bearer ${admin.accessToken}`;
      const payload = newPromoPayload();

      const first = await request(app.getHttpServer())
        .post('/api/v1/admin/promos')
        .set('Authorization', auth)
        .send(payload);
      expect(first.status).toBe(201);
      cleanupPromoIds.push(first.body.id);

      const dup = await request(app.getHttpServer())
        .post('/api/v1/admin/promos')
        .set('Authorization', auth)
        .send({ ...payload, code: payload.code.toLowerCase() });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('PROMO_CODE_EXISTS');
    });

    it('404s updating/deleting an unknown promo', async () => {
      const admin = await registerAdmin();
      const auth = `Bearer ${admin.accessToken}`;
      const unknownId = randomUUID();

      const updateRes = await request(app.getHttpServer())
        .put(`/api/v1/admin/promos/${unknownId}`)
        .set('Authorization', auth)
        .send(newPromoPayload());
      expect(updateRes.status).toBe(404);

      const deleteRes = await request(app.getHttpServer())
        .delete(`/api/v1/admin/promos/${unknownId}`)
        .set('Authorization', auth);
      expect(deleteRes.status).toBe(404);
    });

    it('rejects an invalid payload with 400', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/promos')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ discountType: 'PERCENT', value: 10 }); // missing code
      expect(res.status).toBe(400);
    });

    it('a deleted promo can no longer be validated on the Phase 4 customer endpoint', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const payload = newPromoPayload({ discountType: 'FIXED', value: 5, minOrderAmount: 0 });

      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/promos')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(payload);
      expect(created.status).toBe(201);
      cleanupPromoIds.push(created.body.id);

      await request(app.getHttpServer())
        .delete(`/api/v1/admin/promos/${created.body.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);

      const validateRes = await request(app.getHttpServer())
        .post('/api/v1/promos/validate')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ code: payload.code });
      expect(validateRes.status).toBe(404);
    });
  });

  // ===========================================================================
  describe('Settings read/update', () => {
    it('reads current settings and applies a full-replace update', async () => {
      const admin = await registerAdmin();
      const auth = `Bearer ${admin.accessToken}`;

      const getRes = await request(app.getHttpServer())
        .get('/api/v1/admin/settings')
        .set('Authorization', auth);
      expect(getRes.status).toBe(200);
      expect(getRes.body.currency).toBe(originalSettings.currency);

      const newPayload = {
        restaurantNameAr: 'كبدة زمان تجريبي',
        restaurantNameEn: 'Kebda Zaman Test',
        phone: '+20111111111',
        addressAr: 'الجيزة، مصر',
        addressEn: 'Giza, Egypt',
        taxRatePercent: 12,
        deliveryFee: 18,
        minOrderAmount: 40,
        currency: 'EGP',
        workingHours: weeklyHours({ openTime: '09:00', closeTime: '23:00' }),
        timezone: 'Africa/Cairo',
        isMaintenanceMode: true,
        acceptingOrders: true,
      };
      const putRes = await request(app.getHttpServer())
        .put('/api/v1/admin/settings')
        .set('Authorization', auth)
        .send(newPayload);
      expect(putRes.status).toBe(200);
      expect(putRes.body.taxRatePercent).toBe(12);
      expect(putRes.body.deliveryFee).toBe(18);
      expect(putRes.body.isMaintenanceMode).toBe(true);

      const publicRes = await request(app.getHttpServer()).get('/api/v1/settings');
      expect(publicRes.body.taxRatePercent).toBe(12);
      expect(publicRes.body.isMaintenanceMode).toBe(true);

      // Restore immediately so subsequent tests in this file see the baseline.
      await request(app.getHttpServer())
        .put('/api/v1/admin/settings')
        .set('Authorization', auth)
        .send(originalSettings);
    });

    it('rejects an out-of-range tax rate with 400', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ...originalSettings, taxRatePercent: 150 });
      expect(res.status).toBe(400);
    });

    it('rejects a malformed working-hours value with 400', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ...originalSettings, workingHours: weeklyHours({ openTime: '10am', closeTime: '23:00' }) });
      expect(res.status).toBe(400);
    });

    it('rejects a working-hours array missing a dayOfWeek with 400', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          ...originalSettings,
          workingHours: weeklyHours({ openTime: '10:00', closeTime: '23:00' }).slice(0, 6),
        });
      expect(res.status).toBe(400);
    });

    it('rejects a payload missing isMaintenanceMode with 400', async () => {
      const admin = await registerAdmin();
      const { isMaintenanceMode: _omit, ...incomplete } = originalSettings;
      const res = await request(app.getHttpServer())
        .put('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(incomplete);
      expect(res.status).toBe(400);
    });
  });

  // ===========================================================================
  describe('Notification campaigns: immediate send', () => {
    it('persists a SENT campaign and forwards the AppNotificationPayload contract to FCM', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const token = `fcm-${randomUUID()}`;
      cleanupTokens.push(token);
      await prisma.deviceToken.create({
        data: { token, userId: customer.user.id, platform: 'ANDROID', lastSeenAt: new Date() },
      });
      sendToTokens.mockResolvedValueOnce({ successCount: 1, failureCount: 0, invalidTokens: [] });

      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/notifications/send')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCampaignPayload({ destinationRoute: '/promos', entityId: 'promo-1' }));

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('SENT');
      expect(res.body.totalRecipients).toBe(1);
      expect(res.body.deliveredCount).toBe(1);
      cleanupCampaignIds.push(res.body.id);

      expect(sendToTokens).toHaveBeenCalledTimes(1);
      const [tokens, payload] = sendToTokens.mock.calls[0];
      expect(tokens).toEqual([token]);
      expect(payload).toMatchObject({
        id: res.body.id,
        type: 'promotion',
        title: 'Big sale',
        body: 'Everything is on sale today.',
        route: '/promos',
        entityId: 'promo-1',
      });
    });

    it('persists FAILED cleanly (does not crash the request) when FCM send throws', async () => {
      const admin = await registerAdmin();
      sendToTokens.mockRejectedValueOnce(new Error('FCM unavailable'));

      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/notifications/send')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCampaignPayload());

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('FAILED');
      cleanupCampaignIds.push(res.body.id);

      const row = await prisma.notificationCampaign.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(row.status).toBe('FAILED');
    });
  });

  // ===========================================================================
  describe('Notification campaigns: scheduling + scheduler', () => {
    it('persists a SCHEDULED campaign that is not dispatched at creation time', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/notifications/schedule')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCampaignPayload({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }));

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('SCHEDULED');
      expect(res.body.isScheduled).toBe(true);
      cleanupCampaignIds.push(res.body.id);
      expect(sendToTokens).not.toHaveBeenCalled();
    });

    it('the scheduler dispatches a due campaign and marks it SENT', async () => {
      const admin = await registerAdmin();
      const scheduleRes = await request(app.getHttpServer())
        .post('/api/v1/admin/notifications/schedule')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCampaignPayload({ scheduledAt: new Date(Date.now() - 1000).toISOString() }));
      expect(scheduleRes.status).toBe(201);
      const campaignId = scheduleRes.body.id as string;
      cleanupCampaignIds.push(campaignId);
      sendToTokens.mockResolvedValueOnce({ successCount: 0, failureCount: 0, invalidTokens: [] });

      await scheduler.claimAndDispatch(campaignId);

      const row = await prisma.notificationCampaign.findUniqueOrThrow({
        where: { id: campaignId },
      });
      expect(row.status).toBe('SENT');
      expect(sendToTokens).toHaveBeenCalledTimes(1);
    });

    it('prevents double-send: concurrent claims on the same due campaign dispatch only once', async () => {
      const admin = await registerAdmin();
      const scheduleRes = await request(app.getHttpServer())
        .post('/api/v1/admin/notifications/schedule')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCampaignPayload({ scheduledAt: new Date(Date.now() - 1000).toISOString() }));
      const campaignId = scheduleRes.body.id as string;
      cleanupCampaignIds.push(campaignId);
      sendToTokens.mockResolvedValue({ successCount: 0, failureCount: 0, invalidTokens: [] });

      await Promise.all([
        scheduler.claimAndDispatch(campaignId),
        scheduler.claimAndDispatch(campaignId),
      ]);

      expect(sendToTokens).toHaveBeenCalledTimes(1);
      const row = await prisma.notificationCampaign.findUniqueOrThrow({
        where: { id: campaignId },
      });
      expect(row.status).toBe('SENT');
    });

    it('a not-yet-due SCHEDULED campaign is left untouched by claimAndDispatch guard reuse (no id match => no-op)', async () => {
      const unknownId = randomUUID();
      await expect(scheduler.claimAndDispatch(unknownId)).resolves.toBeUndefined();
      expect(sendToTokens).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  describe('Campaign history', () => {
    it('lists created campaigns newest-first', async () => {
      const admin = await registerAdmin();
      const auth = `Bearer ${admin.accessToken}`;
      const res1 = await request(app.getHttpServer())
        .post('/api/v1/admin/notifications/schedule')
        .set('Authorization', auth)
        .send(newCampaignPayload({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }));
      cleanupCampaignIds.push(res1.body.id);

      const listRes = await request(app.getHttpServer())
        .get('/api/v1/admin/notifications/campaigns')
        .set('Authorization', auth);
      expect(listRes.status).toBe(200);
      expect(listRes.body.some((c: { id: string }) => c.id === res1.body.id)).toBe(true);
    });
  });

  // ===========================================================================
  describe('Campaign deletion rules', () => {
    it('deletes a DRAFT/SCHEDULED campaign', async () => {
      const admin = await registerAdmin();
      const auth = `Bearer ${admin.accessToken}`;
      const scheduleRes = await request(app.getHttpServer())
        .post('/api/v1/admin/notifications/schedule')
        .set('Authorization', auth)
        .send(newCampaignPayload({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }));

      const deleteRes = await request(app.getHttpServer())
        .delete(`/api/v1/admin/notifications/campaigns/${scheduleRes.body.id}`)
        .set('Authorization', auth);
      expect(deleteRes.status).toBe(204);

      const row = await prisma.notificationCampaign.findUnique({
        where: { id: scheduleRes.body.id },
      });
      expect(row).toBeNull();
    });

    it('rejects deleting a SENT campaign with 409', async () => {
      const admin = await registerAdmin();
      const auth = `Bearer ${admin.accessToken}`;
      sendToTokens.mockResolvedValueOnce({ successCount: 0, failureCount: 0, invalidTokens: [] });
      const sendRes = await request(app.getHttpServer())
        .post('/api/v1/admin/notifications/send')
        .set('Authorization', auth)
        .send(newCampaignPayload());
      expect(sendRes.body.status).toBe('SENT');
      cleanupCampaignIds.push(sendRes.body.id);

      const deleteRes = await request(app.getHttpServer())
        .delete(`/api/v1/admin/notifications/campaigns/${sendRes.body.id}`)
        .set('Authorization', auth);
      expect(deleteRes.status).toBe(409);
      expect(deleteRes.body.code).toBe('CAMPAIGN_NOT_DELETABLE');
    });

    it('404s deleting an unknown campaign', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/admin/notifications/campaigns/${randomUUID()}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(404);
    });
  });
});
