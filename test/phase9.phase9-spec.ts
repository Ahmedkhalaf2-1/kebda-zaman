import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { AuthService } from '../src/modules/auth/auth.service';
import { LoyaltyService } from '../src/modules/loyalty/loyalty.service';

const D = (v: string) => new Prisma.Decimal(v);

describe('Phase 9: Addresses, Favorites, Loyalty (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;
  let loyaltyService: LoyaltyService;

  let categoryId: string;
  let menuItemId: string;
  const cleanupUserIds: string[] = [];

  async function registerCustomer() {
    const registered = await authService.register(
      {
        name: 'Phase9 Customer',
        email: `phase9-customer-${randomUUID()}@phase9.local`,
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
        name: 'Phase9 Admin',
        email: `phase9-admin-${randomUUID()}@phase9.local`,
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

  async function registerGuest() {
    const guest = await authService.guest({}, {});
    cleanupUserIds.push(guest.user.id);
    return guest;
  }

  function addressPayload(overrides: Record<string, unknown> = {}) {
    return {
      title: 'Home',
      street: '123 Main St',
      building: 'B1',
      city: 'Cairo',
      ...overrides,
    };
  }

  async function checkout(accessToken: string) {
    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ menuItemId, quantity: 1 });

    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
    expect(res.status).toBe(201);
    return res.body as { id: string; totalAmount: number };
  }

  async function transitionOrder(orderId: string, adminToken: string, statuses: string[]) {
    for (const status of statuses) {
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
    loyaltyService = app.get(LoyaltyService);

    const category = await prisma.category.create({
      data: { nameAr: 'فئة المرحلة 9', nameEn: 'Phase 9 Category' },
    });
    categoryId = category.id;
    const item = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف المرحلة 9',
        nameEn: 'Phase 9 Item',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: D('1000.00'),
        imageUrl: 'https://example.test/img.png',
      },
    });
    menuItemId = item.id;
  });

  afterAll(async () => {
    await prisma.loyaltyTransaction.deleteMany({
      where: { account: { userId: { in: cleanupUserIds } } },
    });
    await prisma.loyaltyAccount.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.favorite.deleteMany({ where: { userId: { in: cleanupUserIds } } });
    await prisma.address.deleteMany({ where: { userId: { in: cleanupUserIds } } });
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
  describe('Addresses: CRUD, ownership, default handling', () => {
    it('the first address created for a user is automatically the default', async () => {
      const customer = await registerCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/me/addresses')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send(addressPayload());
      expect(res.status).toBe(201);
      expect(res.body.isDefault).toBe(true);
      expect(res.body.userId).toBe(customer.user.id);
    });

    it('creating a second address as default unsets the previous default', async () => {
      const customer = await registerCustomer();
      const first = await request(app.getHttpServer())
        .post('/api/v1/me/addresses')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send(addressPayload({ title: 'Home' }));
      expect(first.body.isDefault).toBe(true);

      const second = await request(app.getHttpServer())
        .post('/api/v1/me/addresses')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send(addressPayload({ title: 'Work', isDefault: true }));
      expect(second.status).toBe(201);
      expect(second.body.isDefault).toBe(true);

      const list = await request(app.getHttpServer())
        .get('/api/v1/me/addresses')
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(list.body).toHaveLength(2);
      const firstAfter = list.body.find((a: { id: string }) => a.id === first.body.id);
      expect(firstAfter.isDefault).toBe(false);
    });

    it('PATCH .../default switches the default address', async () => {
      const customer = await registerCustomer();
      const first = await request(app.getHttpServer())
        .post('/api/v1/me/addresses')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send(addressPayload({ title: 'Home' }));
      const second = await request(app.getHttpServer())
        .post('/api/v1/me/addresses')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send(addressPayload({ title: 'Work' }));
      expect(second.body.isDefault).toBe(false);

      const patchRes = await request(app.getHttpServer())
        .patch(`/api/v1/me/addresses/${second.body.id}/default`)
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.isDefault).toBe(true);

      const firstRow = await prisma.address.findUniqueOrThrow({ where: { id: first.body.id } });
      expect(firstRow.isDefault).toBe(false);
    });

    it('updates and deletes an owned address', async () => {
      const customer = await registerCustomer();
      const created = await request(app.getHttpServer())
        .post('/api/v1/me/addresses')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send(addressPayload());

      const updateRes = await request(app.getHttpServer())
        .put(`/api/v1/me/addresses/${created.body.id}`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send(addressPayload({ city: 'Giza' }));
      expect(updateRes.status).toBe(200);
      expect(updateRes.body.city).toBe('Giza');

      const deleteRes = await request(app.getHttpServer())
        .delete(`/api/v1/me/addresses/${created.body.id}`)
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(deleteRes.status).toBe(204);

      const row = await prisma.address.findUnique({ where: { id: created.body.id } });
      expect(row).toBeNull();
    });

    it("rejects updating/deleting another user's address with 403", async () => {
      const owner = await registerCustomer();
      const intruder = await registerCustomer();
      const created = await request(app.getHttpServer())
        .post('/api/v1/me/addresses')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send(addressPayload());

      const updateRes = await request(app.getHttpServer())
        .put(`/api/v1/me/addresses/${created.body.id}`)
        .set('Authorization', `Bearer ${intruder.accessToken}`)
        .send(addressPayload({ city: 'Alexandria' }));
      expect(updateRes.status).toBe(403);

      const deleteRes = await request(app.getHttpServer())
        .delete(`/api/v1/me/addresses/${created.body.id}`)
        .set('Authorization', `Bearer ${intruder.accessToken}`);
      expect(deleteRes.status).toBe(403);
    });

    it('404s for a nonexistent address id', async () => {
      const customer = await registerCustomer();
      const res = await request(app.getHttpServer())
        .put(`/api/v1/me/addresses/${randomUUID()}`)
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send(addressPayload());
      expect(res.status).toBe(404);
    });

    it('rejects an unauthenticated caller with 401', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/me/addresses');
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  describe('Favorites: add/remove/list, duplicate prevention', () => {
    it('adds a favorite and returns the updated MenuItem[] list', async () => {
      const customer = await registerCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/me/favorites')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ menuItemId });
      expect(res.status).toBe(201);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.some((item: { id: string }) => item.id === menuItemId)).toBe(true);
    });

    it('rejects adding the same favorite twice with 409', async () => {
      const customer = await registerCustomer();
      await request(app.getHttpServer())
        .post('/api/v1/me/favorites')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ menuItemId });

      const dup = await request(app.getHttpServer())
        .post('/api/v1/me/favorites')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ menuItemId });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('FAVORITE_ALREADY_EXISTS');
    });

    it('404s adding an unknown menu item', async () => {
      const customer = await registerCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/me/favorites')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ menuItemId: randomUUID() });
      expect(res.status).toBe(404);
    });

    it('lists and removes a favorite', async () => {
      const customer = await registerCustomer();
      await request(app.getHttpServer())
        .post('/api/v1/me/favorites')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ menuItemId });

      const listRes = await request(app.getHttpServer())
        .get('/api/v1/me/favorites')
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(listRes.body).toHaveLength(1);

      const deleteRes = await request(app.getHttpServer())
        .delete(`/api/v1/me/favorites/${menuItemId}`)
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(deleteRes.status).toBe(204);

      const listAfter = await request(app.getHttpServer())
        .get('/api/v1/me/favorites')
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(listAfter.body).toHaveLength(0);
    });

    it('404s removing a favorite that was never added', async () => {
      const customer = await registerCustomer();
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/me/favorites/${menuItemId}`)
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(res.status).toBe(404);
    });

    it('rejects an ADMIN caller with 403 (CUSTOMER-only)', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .get('/api/v1/me/favorites')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ===========================================================================
  describe('Loyalty: account, earning, balance, redemption, history', () => {
    it('lazily creates an account with a zero balance on first read', async () => {
      const customer = await registerCustomer();
      const res = await request(app.getHttpServer())
        .get('/api/v1/me/loyalty')
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.userId).toBe(customer.user.id);
      expect(res.body.pointsBalance).toBe(0);
    });

    it('rejects a guest with 403 (no persistent loyalty benefits)', async () => {
      const guest = await registerGuest();
      const res = await request(app.getHttpServer())
        .get('/api/v1/me/loyalty')
        .set('Authorization', `Bearer ${guest.accessToken}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('GUEST_NOT_ELIGIBLE');
    });

    it('a guest order that reaches DELIVERED never earns loyalty points', async () => {
      const guest = await registerGuest();
      const admin = await registerAdmin();
      const order = await checkout(guest.accessToken);
      await transitionOrder(order.id, admin.accessToken, [
        'confirmed',
        'preparing',
        'outForDelivery',
        'delivered',
      ]);

      const account = await prisma.loyaltyAccount.findUnique({ where: { userId: guest.user.id } });
      expect(account).toBeNull();
    });

    it('awards points when an order is DELIVERED, matching the server-computed total', async () => {
      const customer = await registerCustomer();
      const admin = await registerAdmin();
      const order = await checkout(customer.accessToken);

      await transitionOrder(order.id, admin.accessToken, [
        'confirmed',
        'preparing',
        'outForDelivery',
        'delivered',
      ]);

      const expectedPoints = Math.floor(order.totalAmount / 10);
      const account = await prisma.loyaltyAccount.findUniqueOrThrow({
        where: { userId: customer.user.id },
      });
      expect(account.pointsBalance).toBe(expectedPoints);

      const transaction = await prisma.loyaltyTransaction.findFirstOrThrow({
        where: { accountId: account.id, reason: 'ORDER_EARNED' },
      });
      expect(transaction.delta).toBe(expectedPoints);
      expect(transaction.orderId).toBe(order.id);
    });

    it('does not double-credit when earning is retried for the same order (idempotent)', async () => {
      const customer = await registerCustomer();
      const admin = await registerAdmin();
      const order = await checkout(customer.accessToken);
      await transitionOrder(order.id, admin.accessToken, [
        'confirmed',
        'preparing',
        'outForDelivery',
        'delivered',
      ]);

      const beforeRetry = await prisma.loyaltyAccount.findUniqueOrThrow({
        where: { userId: customer.user.id },
      });

      const orderRow = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      // Simulate a retry/duplicate trigger of the same earn event directly through the service.
      await loyaltyService.earnForOrder(orderRow);

      const afterRetry = await prisma.loyaltyAccount.findUniqueOrThrow({
        where: { userId: customer.user.id },
      });
      expect(afterRetry.pointsBalance).toBe(beforeRetry.pointsBalance);
      const transactionCount = await prisma.loyaltyTransaction.count({
        where: { accountId: beforeRetry.id, reason: 'ORDER_EARNED' },
      });
      expect(transactionCount).toBe(1);
    });

    it('never awards points for a cancelled order', async () => {
      const customer = await registerCustomer();
      const admin = await registerAdmin();
      const order = await checkout(customer.accessToken);
      await transitionOrder(order.id, admin.accessToken, ['cancelled']);

      const transaction = await prisma.loyaltyTransaction.findFirst({
        where: { orderId: order.id },
      });
      expect(transaction).toBeNull();
    });

    it('redeems a reward, deducting points and recording an immutable transaction', async () => {
      const customer = await registerCustomer();
      const admin = await registerAdmin();
      const order = await checkout(customer.accessToken);
      await transitionOrder(order.id, admin.accessToken, [
        'confirmed',
        'preparing',
        'outForDelivery',
        'delivered',
      ]);
      const account = await prisma.loyaltyAccount.findUniqueOrThrow({
        where: { userId: customer.user.id },
      });
      expect(account.pointsBalance).toBeGreaterThanOrEqual(100);

      const res = await request(app.getHttpServer())
        .post('/api/v1/me/loyalty/redeem')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rewardId: 'free-delivery' });
      expect(res.status).toBe(201);
      expect(res.body.account.pointsBalance).toBe(account.pointsBalance - 100);
      expect(res.body.redemption.rewardId).toBe('free-delivery');

      const redemptionTx = await prisma.loyaltyTransaction.findFirstOrThrow({
        where: { accountId: account.id, reason: 'REDEMPTION' },
      });
      expect(redemptionTx.delta).toBe(-100);
    });

    it('rejects redemption with insufficient points (422)', async () => {
      const customer = await registerCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/me/loyalty/redeem')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rewardId: 'discount-25' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INSUFFICIENT_POINTS');
    });

    it('404s redeeming an unknown reward id', async () => {
      const customer = await registerCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/me/loyalty/redeem')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rewardId: 'not-a-real-reward' });
      expect(res.status).toBe(404);
    });

    it('rejects a client-supplied points field on redeem (never trusts client points)', async () => {
      const customer = await registerCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/me/loyalty/redeem')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rewardId: 'free-delivery', points: 999999 });
      expect(res.status).toBe(400); // forbidNonWhitelisted rejects the extra field
    });

    it('lists transaction history newest-first', async () => {
      const customer = await registerCustomer();
      const admin = await registerAdmin();
      const order = await checkout(customer.accessToken);
      await transitionOrder(order.id, admin.accessToken, [
        'confirmed',
        'preparing',
        'outForDelivery',
        'delivered',
      ]);
      await request(app.getHttpServer())
        .post('/api/v1/me/loyalty/redeem')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ rewardId: 'free-delivery' });

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/loyalty/transactions')
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].reason).toBe('REDEMPTION');
      expect(res.body[1].reason).toBe('ORDER_EARNED');
    });
  });
});
