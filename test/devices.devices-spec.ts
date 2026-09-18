import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { AuthService } from '../src/modules/auth/auth.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { FIREBASE_ADMIN_APP } from '../src/modules/notifications/firebase-admin.provider';

// firebase-admin's getMessaging() validates that the App it's given is a
// real, internally-registered Firebase app — a plain mock object isn't
// enough. Mocking the whole module lets NotificationsService's send logic
// (payload shaping, success/failure counting, invalid-token cleanup) be
// exercised with zero real Firebase network calls.
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getMessaging } = require('firebase-admin/messaging') as { getMessaging: jest.Mock };

describe('Devices & FCM (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;
  let notificationsService: NotificationsService;

  const cleanupUserIds: string[] = [];
  const cleanupTokens: string[] = [];

  async function registerUser() {
    const registered = await authService.register(
      {
        name: 'Device Test User',
        email: `device-test-${randomUUID()}@phase6.local`,
        password: 'correcthorsebattery',
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    return registered;
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Enabled but fully mocked "app" — truthy so NotificationsService
      // attempts to send; getMessaging() itself is mocked above.
      .overrideProvider(FIREBASE_ADMIN_APP)
      .useValue({ name: 'mock-app' })
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
    notificationsService = app.get(NotificationsService);
  });

  afterAll(async () => {
    if (cleanupTokens.length > 0) {
      await prisma.deviceToken.deleteMany({ where: { token: { in: cleanupTokens } } });
    }
    if (cleanupUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    }
    await app.close();
  });

  beforeEach(() => {
    getMessaging.mockReset();
  });

  // ===========================================================================
  describe('POST /devices/register', () => {
    it('creates a token attached to the caller', async () => {
      const { accessToken, user } = await registerUser();
      const token = `fcm-${randomUUID()}`;
      cleanupTokens.push(token);

      const res = await request(app.getHttpServer())
        .post('/api/v1/devices/register')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ token, platform: 'ANDROID' });

      expect(res.status).toBe(201);
      expect(res.body.userId).toBe(user.id);
      expect(res.body.platform).toBe('ANDROID');
      expect(res.body.isActive).toBe(true);
    });

    it('re-registering the same token re-attaches it to whoever calls (device changes account)', async () => {
      const first = await registerUser();
      const second = await registerUser();
      const token = `fcm-${randomUUID()}`;
      cleanupTokens.push(token);

      await request(app.getHttpServer())
        .post('/api/v1/devices/register')
        .set('Authorization', `Bearer ${first.accessToken}`)
        .send({ token, platform: 'ANDROID' });

      const res = await request(app.getHttpServer())
        .post('/api/v1/devices/register')
        .set('Authorization', `Bearer ${second.accessToken}`)
        .send({ token, platform: 'ANDROID' });
      expect(res.status).toBe(201);
      expect(res.body.userId).toBe(second.user.id);

      const row = await prisma.deviceToken.findUniqueOrThrow({ where: { token } });
      expect(row.userId).toBe(second.user.id);
    });

    it('requires authentication', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/devices/register')
        .send({ token: `fcm-${randomUUID()}`, platform: 'ANDROID' });
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  describe('Multiple devices per user', () => {
    it('lets one user register several distinct device tokens', async () => {
      const { accessToken, user } = await registerUser();
      const tokenA = `fcm-${randomUUID()}`;
      const tokenB = `fcm-${randomUUID()}`;
      cleanupTokens.push(tokenA, tokenB);

      await request(app.getHttpServer())
        .post('/api/v1/devices/register')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ token: tokenA, platform: 'ANDROID' });
      await request(app.getHttpServer())
        .post('/api/v1/devices/register')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ token: tokenB, platform: 'IOS' });

      const rows = await prisma.deviceToken.findMany({ where: { userId: user.id } });
      expect(rows.map((r) => r.token).sort()).toEqual([tokenA, tokenB].sort());
    });
  });

  // ===========================================================================
  describe('Guest device', () => {
    it('attaches a device token to a guest session (real userId, not null)', async () => {
      const guest = await authService.guest({}, {});
      cleanupUserIds.push(guest.user.id);
      expect(guest.user.isGuest).toBe(true);
      const token = `fcm-${randomUUID()}`;
      cleanupTokens.push(token);

      const res = await request(app.getHttpServer())
        .post('/api/v1/devices/register')
        .set('Authorization', `Bearer ${guest.accessToken}`)
        .send({ token, platform: 'ANDROID' });
      expect(res.status).toBe(201);
      expect(res.body.userId).toBe(guest.user.id);
    });

    it('an unclaimed (userId=null) token is token-scoped: any authenticated caller may update/delete it', async () => {
      const token = `fcm-${randomUUID()}`;
      cleanupTokens.push(token);
      await prisma.deviceToken.create({
        data: { token, platform: 'ANDROID', lastSeenAt: new Date(), userId: null },
      });

      const { accessToken, user } = await registerUser();
      const res = await request(app.getHttpServer())
        .put('/api/v1/devices/token')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ oldToken: token, token, platform: 'ANDROID' });
      expect(res.status).toBe(200);
      expect(res.body.userId).toBe(user.id); // now claimed
    });
  });

  // ===========================================================================
  describe('PUT /devices/token (rotate / refresh)', () => {
    it('moves the record from oldToken to a new token, keeping the user association', async () => {
      const { accessToken, user } = await registerUser();
      const oldToken = `fcm-${randomUUID()}`;
      const newToken = `fcm-${randomUUID()}`;
      cleanupTokens.push(oldToken, newToken);

      await request(app.getHttpServer())
        .post('/api/v1/devices/register')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ token: oldToken, platform: 'ANDROID' });

      const res = await request(app.getHttpServer())
        .put('/api/v1/devices/token')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ oldToken, token: newToken, platform: 'ANDROID' });
      expect(res.status).toBe(200);
      expect(res.body.token).toBe(newToken);
      expect(res.body.userId).toBe(user.id);

      const oldRow = await prisma.deviceToken.findUnique({ where: { token: oldToken } });
      expect(oldRow).toBeNull();
      const newRow = await prisma.deviceToken.findUniqueOrThrow({ where: { token: newToken } });
      expect(newRow.userId).toBe(user.id);
    });

    it('without oldToken behaves like register (upsert by new token)', async () => {
      const { accessToken, user } = await registerUser();
      const token = `fcm-${randomUUID()}`;
      cleanupTokens.push(token);

      const res = await request(app.getHttpServer())
        .put('/api/v1/devices/token')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ token, platform: 'WEB' });
      expect(res.status).toBe(200);
      expect(res.body.userId).toBe(user.id);
    });

    it('404s when rotating an unknown oldToken', async () => {
      const { accessToken } = await registerUser();
      const res = await request(app.getHttpServer())
        .put('/api/v1/devices/token')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          oldToken: `fcm-${randomUUID()}`,
          token: `fcm-${randomUUID()}`,
          platform: 'ANDROID',
        });
      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================
  describe('DELETE /devices/token (logout)', () => {
    it('removes the token', async () => {
      const { accessToken } = await registerUser();
      const token = `fcm-${randomUUID()}`;

      await request(app.getHttpServer())
        .post('/api/v1/devices/register')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ token, platform: 'ANDROID' });

      const res = await request(app.getHttpServer())
        .delete('/api/v1/devices/token')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ token });
      expect(res.status).toBe(204);

      const row = await prisma.deviceToken.findUnique({ where: { token } });
      expect(row).toBeNull();
    });

    it('404s for an unknown token', async () => {
      const { accessToken } = await registerUser();
      const res = await request(app.getHttpServer())
        .delete('/api/v1/devices/token')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ token: `fcm-${randomUUID()}` });
      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================
  describe('Token ownership / security', () => {
    it('rejects updating a token owned by a different user (404, not leaked)', async () => {
      const owner = await registerUser();
      const intruder = await registerUser();
      const token = `fcm-${randomUUID()}`;
      cleanupTokens.push(token);
      await request(app.getHttpServer())
        .post('/api/v1/devices/register')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ token, platform: 'ANDROID' });

      const res = await request(app.getHttpServer())
        .put('/api/v1/devices/token')
        .set('Authorization', `Bearer ${intruder.accessToken}`)
        .send({ oldToken: token, token: `fcm-${randomUUID()}`, platform: 'ANDROID' });
      expect(res.status).toBe(404);
    });

    it('rejects deleting a token owned by a different user', async () => {
      const owner = await registerUser();
      const intruder = await registerUser();
      const token = `fcm-${randomUUID()}`;
      cleanupTokens.push(token);
      await request(app.getHttpServer())
        .post('/api/v1/devices/register')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ token, platform: 'ANDROID' });

      const res = await request(app.getHttpServer())
        .delete('/api/v1/devices/token')
        .set('Authorization', `Bearer ${intruder.accessToken}`)
        .send({ token });
      expect(res.status).toBe(404);

      const row = await prisma.deviceToken.findUniqueOrThrow({ where: { token } });
      expect(row.userId).toBe(owner.user.id); // untouched
    });
  });

  // ===========================================================================
  describe('Mocked FCM send: success/failure + invalid-token cleanup', () => {
    it('counts successes/failures and only deactivates tokens with an invalid-token error code', async () => {
      const { user } = await registerUser();
      const goodToken = `fcm-${randomUUID()}`;
      const deadToken = `fcm-${randomUUID()}`;
      const transientFailToken = `fcm-${randomUUID()}`;
      cleanupTokens.push(goodToken, deadToken, transientFailToken);

      await prisma.deviceToken.createMany({
        data: [
          { token: goodToken, userId: user.id, platform: 'ANDROID', lastSeenAt: new Date() },
          { token: deadToken, userId: user.id, platform: 'ANDROID', lastSeenAt: new Date() },
          {
            token: transientFailToken,
            userId: user.id,
            platform: 'ANDROID',
            lastSeenAt: new Date(),
          },
        ],
      });

      const sendEachForMulticast = jest.fn().mockResolvedValue({
        successCount: 1,
        failureCount: 2,
        responses: [
          { success: true },
          { success: false, error: { code: 'messaging/registration-token-not-registered' } },
          { success: false, error: { code: 'messaging/internal-error' } },
        ],
      });
      getMessaging.mockReturnValue({ sendEachForMulticast });

      const result = await notificationsService.sendToTokens(
        [goodToken, deadToken, transientFailToken],
        {
          id: randomUUID(),
          type: 'order_confirmed',
          title: 'Order confirmed',
          body: 'Your order has been confirmed.',
          route: '/orders/tracking/abc',
          entityId: 'abc',
        },
      );

      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(2);
      expect(result.invalidTokens).toEqual([deadToken]);

      // Payload shape sent to FCM matches AppNotificationPayload keys exactly.
      const sentMessage = sendEachForMulticast.mock.calls[0][0];
      expect(sentMessage.data).toEqual({
        id: expect.any(String),
        type: 'order_confirmed',
        title: 'Order confirmed',
        body: 'Your order has been confirmed.',
        route: '/orders/tracking/abc',
        entityId: 'abc',
      });
      Object.values(sentMessage.data).forEach((value) => expect(typeof value).toBe('string'));

      const [good, dead, transient] = await Promise.all([
        prisma.deviceToken.findUniqueOrThrow({ where: { token: goodToken } }),
        prisma.deviceToken.findUniqueOrThrow({ where: { token: deadToken } }),
        prisma.deviceToken.findUniqueOrThrow({ where: { token: transientFailToken } }),
      ]);
      expect(good.isActive).toBe(true);
      expect(dead.isActive).toBe(false); // cleaned up
      expect(transient.isActive).toBe(true); // transient error, not cleaned up
    });

    it('sends the correctly-shaped payload for an order-status change to all active devices', async () => {
      const { user } = await registerUser();
      const token = `fcm-${randomUUID()}`;
      cleanupTokens.push(token);
      await prisma.deviceToken.create({
        data: { token, userId: user.id, platform: 'ANDROID', lastSeenAt: new Date() },
      });

      const sendEachForMulticast = jest
        .fn()
        .mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true }] });
      getMessaging.mockReturnValue({ sendEachForMulticast });

      const result = await notificationsService.sendOrderStatusNotification({
        id: 'order-123',
        userId: user.id,
        status: 'OUT_FOR_DELIVERY',
        deliveryMethod: 'DELIVERY',
      });

      expect(result.successCount).toBe(1);
      const sentMessage = sendEachForMulticast.mock.calls[0][0];
      expect(sentMessage.tokens).toEqual([token]);
      expect(sentMessage.data.type).toBe('order_out_for_delivery');
      expect(sentMessage.data.route).toBe('/orders/tracking/order-123');
      expect(sentMessage.data.entityId).toBe('order-123');
    });

    it('targets only the order owner: another user\'s device tokens are never included', async () => {
      const owner = await registerUser();
      const otherUser = await registerUser();
      const ownerToken = `fcm-${randomUUID()}`;
      const otherToken = `fcm-${randomUUID()}`;
      cleanupTokens.push(ownerToken, otherToken);
      await prisma.deviceToken.createMany({
        data: [
          {
            token: ownerToken,
            userId: owner.user.id,
            platform: 'ANDROID',
            lastSeenAt: new Date(),
          },
          {
            token: otherToken,
            userId: otherUser.user.id,
            platform: 'ANDROID',
            lastSeenAt: new Date(),
          },
        ],
      });

      const sendEachForMulticast = jest
        .fn()
        .mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true }] });
      getMessaging.mockReturnValue({ sendEachForMulticast });

      await notificationsService.sendOrderStatusNotification({
        id: 'order-owner-only',
        userId: owner.user.id,
        status: 'CONFIRMED',
        deliveryMethod: 'DELIVERY',
      });

      const sentMessage = sendEachForMulticast.mock.calls[0][0];
      expect(sentMessage.tokens).toEqual([ownerToken]);
      expect(sentMessage.tokens).not.toContain(otherToken);
    });
  });

  // ===========================================================================
  describe('Safe no-op when Firebase credentials are absent', () => {
    it('does not throw and reports every token as a failure without calling FCM', async () => {
      // A fresh module WITHOUT the FIREBASE_ADMIN_APP override reflects the
      // real boot path in this test environment (no credentials configured).
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const bareApp = moduleRef.createNestApplication();
      await bareApp.init();
      const service = bareApp.get(NotificationsService);

      expect(service.isEnabled).toBe(false);
      const result = await service.sendToTokens(['some-token'], {
        id: randomUUID(),
        type: 'order_confirmed',
        title: 'x',
        body: 'y',
      });
      expect(result).toEqual({ successCount: 0, failureCount: 1, invalidTokens: [] });

      await bareApp.close();
    });
  });
});
