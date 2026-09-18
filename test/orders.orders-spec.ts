import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { AuthService } from '../src/modules/auth/auth.service';
import { GoogleRoutesService } from '../src/modules/delivery-pricing/google-routes.service';

const D = (v: string) => new Prisma.Decimal(v);

/** Distance-based delivery pricing always calls Google Routes server-side —
 * automated tests must never call the real API, so every DELIVERY checkout
 * here goes through this mock (5km -> first tier, non-zero fee). */
const mockGoogleRoutesService = {
  computeRoute: jest.fn().mockResolvedValue({ distanceMeters: 5_000, durationSeconds: 600 }),
};

describe('Orders & Checkout (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;

  let categoryId: string;
  let checkoutItem: { id: string };
  let cheapItem: { id: string };
  let optionsItem: { id: string; variantId: string; addonId: string };
  let saleItem: { id: string };

  const cleanupUserIds: string[] = [];
  const deliveryAddress = {
    title: 'Home',
    street: '123 Main St',
    building: 'B1',
    city: 'Cairo',
  };
  const deliveryAddressWithPin = { ...deliveryAddress, latitude: 30.0444, longitude: 31.2357 };

  async function registerUser() {
    const registered = await authService.register(
      {
        name: 'Order Test User',
        email: `order-test-${randomUUID()}@phase5.local`,
        password: 'correcthorsebattery',
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    return registered;
  }

  async function addToCart(
    accessToken: string,
    body: { menuItemId: string; variantId?: string; addonIds?: string[]; quantity?: number },
  ) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ quantity: 1, ...body });
    expect(res.status).toBe(201);
    return res.body;
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
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
      data: { nameAr: 'فئة الطلبات', nameEn: 'Phase 5 Orders Category' },
    });
    categoryId = category.id;

    checkoutItem = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف الدفع',
        nameEn: 'Checkout Item',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: D('60.00'),
        imageUrl: 'https://example.test/img.png',
      },
    });

    cheapItem = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف رخيص',
        nameEn: 'Cheap Item',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: D('10.00'),
        imageUrl: 'https://example.test/img.png',
      },
    });

    const withOptions = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف بخيارات',
        nameEn: 'Options Item',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: D('40.00'),
        imageUrl: 'https://example.test/img.png',
        variants: {
          create: [
            {
              nameAr: 'كبير',
              nameEn: 'Large',
              priceDelta: D('10.00'),
              isDefault: true,
              isActive: true,
            },
          ],
        },
        addonGroups: {
          create: [
            {
              titleAr: 'إضافات',
              titleEn: 'Extras',
              isRequired: false,
              minSelect: 0,
              maxSelect: 1,
              addons: {
                create: [{ nameAr: 'إضافة', nameEn: 'Extra', price: D('5.00'), isAvailable: true }],
              },
            },
          ],
        },
      },
      include: { variants: true, addonGroups: { include: { addons: true } } },
    });
    optionsItem = {
      id: withOptions.id,
      variantId: withOptions.variants[0].id,
      addonId: withOptions.addonGroups[0].addons[0].id,
    };

    saleItem = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف مخفض',
        nameEn: 'Sale Item',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: D('60.00'),
        salePrice: D('45.00'),
        imageUrl: 'https://example.test/img.png',
      },
    });

    await prisma.promoCode.createMany({
      data: [
        { code: 'PHASE5-VALID10', discountType: 'PERCENT', value: D('10') },
        {
          code: 'PHASE5-EXPIRED',
          discountType: 'FIXED',
          value: D('5.00'),
          expiresAt: new Date(Date.now() - 86_400_000),
        },
        { code: 'PHASE5-RACE', discountType: 'FIXED', value: D('5.00'), maxUsage: 1 },
      ],
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
    await prisma.promoCode.deleteMany({
      where: { code: { in: ['PHASE5-VALID10', 'PHASE5-EXPIRED', 'PHASE5-RACE'] } },
    });
    await prisma.menuItem.deleteMany({ where: { categoryId } });
    await prisma.category.delete({ where: { id: categoryId } });
    await app.close();
  });

  // ===========================================================================
  describe('Successful checkout', () => {
    it('creates a PENDING order, prices it authoritatively, and clears the cart', async () => {
      const { accessToken } = await registerUser();
      await addToCart(accessToken, { menuItemId: checkoutItem.id, quantity: 2 });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('pending');
      expect(res.body.subtotal).toBe(120); // 60 * 2
      expect(res.body.deliveryFee).toBe(0); // pickup
      expect(res.body.totalAmount).toBe(res.body.subtotal + res.body.tax);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].menuItem.nameEn).toBe('Checkout Item');
      expect(res.body.paymentMethod).toBe('cash');
      // Order response contract (deliveryMethod/paymentStatus) — a PICKUP,
      // freshly-checked-out order is PICKUP/PENDING.
      expect(res.body.deliveryMethod).toBe('PICKUP');
      expect(res.body.paymentStatus).toBe('PENDING');

      const cart = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(cart.body.items).toEqual([]);
    });

    it('POST /orders is an equivalent alias for the same checkout handler', async () => {
      const { accessToken } = await registerUser();
      await addToCart(accessToken, { menuItemId: checkoutItem.id });

      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('pending');
    });
  });

  // ===========================================================================
  describe('Client price tampering is ignored (rejected outright)', () => {
    it('rejects a checkout body containing price fields', async () => {
      const { accessToken } = await registerUser();
      await addToCart(accessToken, { menuItemId: checkoutItem.id });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          deliveryMethod: 'PICKUP',
          paymentMethod: 'CASH',
          totalAmount: 0.01,
          tax: 0,
          subtotal: 0.01,
        });
      expect(res.status).toBe(400);
    });
  });

  // ===========================================================================
  describe('Empty cart / below minimum order', () => {
    it('rejects checkout with an empty cart (409)', async () => {
      const { accessToken } = await registerUser();
      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('EMPTY_CART');
    });

    it('rejects checkout below the settings minimum order amount (422) and preserves the cart', async () => {
      const { accessToken } = await registerUser();
      await addToCart(accessToken, { menuItemId: cheapItem.id, quantity: 1 }); // 10.00 < seeded 50.00 minimum

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('BELOW_MIN_ORDER');

      const cart = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(cart.body.items).toHaveLength(1); // preserved, not cleared
    });
  });

  // ===========================================================================
  describe('Unavailable item mid-checkout (rollback + cart preserved)', () => {
    it('rejects checkout once the item goes unavailable after being added, and keeps the cart intact', async () => {
      const { accessToken } = await registerUser();
      const staleSource = await prisma.menuItem.create({
        data: {
          categoryId,
          nameAr: 'يصبح غير متاح',
          nameEn: 'Goes Unavailable',
          descriptionAr: 'وصف',
          descriptionEn: 'description',
          basePrice: D('80.00'),
          imageUrl: 'https://example.test/img.png',
        },
      });
      await addToCart(accessToken, { menuItemId: staleSource.id, quantity: 1 });
      await prisma.menuItem.update({ where: { id: staleSource.id }, data: { isAvailable: false } });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ITEM_UNAVAILABLE');

      const cartRowCount = await prisma.cartItem.count({
        where: { cart: { userId: cleanupUserIds.at(-1) } },
      });
      expect(cartRowCount).toBe(1); // not silently removed
      const orderCount = await prisma.order.count({ where: { userId: cleanupUserIds.at(-1) } });
      expect(orderCount).toBe(0); // no partial order created
    });
  });

  // ===========================================================================
  describe('Invalid / expired promo', () => {
    it('rejects an unknown promo code and preserves the cart', async () => {
      const { accessToken } = await registerUser();
      await addToCart(accessToken, { menuItemId: checkoutItem.id });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH', promoCode: 'NO-SUCH-CODE' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PROMO_NOT_FOUND');

      const cart = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(cart.body.items).toHaveLength(1);
    });

    it('rejects an expired promo code', async () => {
      const { accessToken } = await registerUser();
      await addToCart(accessToken, { menuItemId: checkoutItem.id });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH', promoCode: 'PHASE5-EXPIRED' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('PROMO_EXPIRED');
    });

    it('applies a valid promo and snapshots it on the order', async () => {
      const { accessToken } = await registerUser();
      await addToCart(accessToken, { menuItemId: checkoutItem.id });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH', promoCode: 'phase5-valid10' });
      expect(res.status).toBe(201);
      expect(res.body.discount).toBe(6); // 10% of 60
    });
  });

  // ===========================================================================
  describe('Promo usage race (transaction rollback under concurrency)', () => {
    it('lets exactly one of two concurrent checkouts consume the last promo slot; the loser keeps its cart', async () => {
      const userA = await registerUser();
      const userB = await registerUser();
      await addToCart(userA.accessToken, { menuItemId: checkoutItem.id });
      await addToCart(userB.accessToken, { menuItemId: checkoutItem.id });

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/checkout')
          .set('Authorization', `Bearer ${userA.accessToken}`)
          .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH', promoCode: 'PHASE5-RACE' }),
        request(app.getHttpServer())
          .post('/api/v1/checkout')
          .set('Authorization', `Bearer ${userB.accessToken}`)
          .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH', promoCode: 'PHASE5-RACE' }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 422]);

      const [winner, loser] = resA.status === 201 ? [userA, userB] : [userB, userA];
      void winner;

      const loserCartCount = await prisma.cartItem.count({
        where: { cart: { userId: loser.user.id } },
      });
      expect(loserCartCount).toBe(1); // rollback preserved the loser's cart

      const promo = await prisma.promoCode.findUniqueOrThrow({ where: { code: 'PHASE5-RACE' } });
      expect(promo.usageCount).toBe(1); // not double-incremented
    });
  });

  // ===========================================================================
  describe('Order/item/customization snapshots', () => {
    it('freezes catalog data at order time — later catalog edits do not change the order', async () => {
      const { accessToken } = await registerUser();
      await addToCart(accessToken, {
        menuItemId: optionsItem.id,
        variantId: optionsItem.variantId,
        addonIds: [optionsItem.addonId],
      });

      const checkout = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
      expect(checkout.status).toBe(201);
      const orderId = checkout.body.id;
      const originalItem = checkout.body.items[0];
      expect(originalItem.menuItem.nameEn).toBe('Options Item');
      expect(originalItem.selectedVariant.nameEn).toBe('Large');
      expect(originalItem.selectedAddons[0].nameEn).toBe('Extra');
      expect(originalItem.unitPrice).toBe(55); // 40 + 10 + 5

      // Mutate the live catalog after the order was placed.
      await prisma.menuItem.update({
        where: { id: optionsItem.id },
        data: { nameEn: 'Renamed Item', basePrice: D('999.00') },
      });
      await prisma.itemVariant.update({
        where: { id: optionsItem.variantId },
        data: { nameEn: 'Renamed Variant', priceDelta: D('999.00') },
      });
      await prisma.addon.update({
        where: { id: optionsItem.addonId },
        data: { nameEn: 'Renamed Addon', price: D('999.00') },
      });

      const reread = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(reread.status).toBe(200);
      const item = reread.body.items[0];
      expect(item.menuItem.nameEn).toBe('Options Item'); // unchanged snapshot
      expect(item.selectedVariant.nameEn).toBe('Large');
      expect(item.selectedAddons[0].nameEn).toBe('Extra');
      expect(item.unitPrice).toBe(55);
    });
  });

  // ===========================================================================
  describe('Menu Item sale price (discount) — checkout & order snapshot', () => {
    it('charges the salePrice at checkout and snapshots it on the OrderItem', async () => {
      const { accessToken } = await registerUser();
      await addToCart(accessToken, { menuItemId: saleItem.id, quantity: 2 });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
      expect(res.status).toBe(201);
      expect(res.body.subtotal).toBe(90); // 45 (salePrice) * 2, not 60 * 2
      expect(res.body.items[0].unitPrice).toBe(45);
      expect(res.body.items[0].totalPrice).toBe(90);
    });

    it('applies a promo code on top of the already-discounted subtotal (no double discount, no bypass)', async () => {
      const { accessToken } = await registerUser();
      // quantity 2 -> subtotal 90 (>= the seeded 50.00 minimum order amount)
      await addToCart(accessToken, { menuItemId: saleItem.id, quantity: 2 });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH', promoCode: 'PHASE5-VALID10' });
      expect(res.status).toBe(201);
      expect(res.body.subtotal).toBe(90); // discounted item price (45) * 2, not 60 * 2 (120)
      expect(res.body.discount).toBe(9); // 10% of the discounted subtotal (90), not of 120
      expect(res.body.totalAmount).toBe(res.body.subtotal - res.body.discount + res.body.tax);
    });

    it('does not change an already-placed order when the MenuItem sale price is later changed or removed', async () => {
      const { accessToken } = await registerUser();
      // quantity 2 -> subtotal 90 (>= the seeded 50.00 minimum order amount)
      await addToCart(accessToken, { menuItemId: saleItem.id, quantity: 2 });

      const checkout = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
      expect(checkout.status).toBe(201);
      const orderId = checkout.body.id;
      expect(checkout.body.items[0].unitPrice).toBe(45);
      const originalTotal = checkout.body.totalAmount;

      // Admin later removes the discount entirely and changes the base price.
      await prisma.menuItem.update({
        where: { id: saleItem.id },
        data: { salePrice: null, basePrice: D('99.00') },
      });

      const reread = await request(app.getHttpServer())
        .get(`/api/v1/orders/${orderId}`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(reread.status).toBe(200);
      expect(reread.body.items[0].unitPrice).toBe(45); // unchanged snapshot
      expect(reread.body.totalAmount).toBe(originalTotal);

      // Restore the fixture for any tests that run after this one.
      await prisma.menuItem.update({
        where: { id: saleItem.id },
        data: { salePrice: D('45.00'), basePrice: D('60.00') },
      });
    });
  });

  // ===========================================================================
  describe('Initial status history', () => {
    it('writes exactly one PENDING history entry at creation', async () => {
      const { accessToken } = await registerUser();
      await addToCart(accessToken, { menuItemId: checkoutItem.id });
      const checkout = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${checkout.body.id}/status`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(res.body.statusHistory).toHaveLength(1);
      expect(res.body.statusHistory[0].status).toBe('pending');
    });
  });

  // ===========================================================================
  describe('Order number uniqueness', () => {
    it('assigns a unique orderNumber to every concurrently created order', async () => {
      const users = await Promise.all([registerUser(), registerUser(), registerUser()]);
      await Promise.all(
        users.map((u) => addToCart(u.accessToken, { menuItemId: checkoutItem.id })),
      );

      const responses = await Promise.all(
        users.map((u) =>
          request(app.getHttpServer())
            .post('/api/v1/checkout')
            .set('Authorization', `Bearer ${u.accessToken}`)
            .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' }),
        ),
      );
      responses.forEach((r) => expect(r.status).toBe(201));
      const orderNumbers = responses.map((r) => r.body.orderNumber);
      expect(new Set(orderNumbers).size).toBe(orderNumbers.length);
      orderNumbers.forEach((n) => expect(n).toMatch(/^KZ-\d{6}-[0-9a-f]{8}$/));
    });
  });

  // ===========================================================================
  describe('Idempotent checkout retries', () => {
    it('returns the same order for a repeated request with the same Idempotency-Key, without creating a duplicate', async () => {
      const { accessToken, user } = await registerUser();
      await addToCart(accessToken, { menuItemId: checkoutItem.id });
      const key = randomUUID();

      const first = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', key)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
      expect(first.status).toBe(201);

      const second = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Idempotency-Key', key)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);
      // The replayed response must carry the same order-response-contract
      // fields as the original — not silently drop them on the replay path.
      expect(second.body.deliveryMethod).toBe(first.body.deliveryMethod);
      expect(second.body.paymentStatus).toBe(first.body.paymentStatus);

      const orderCount = await prisma.order.count({ where: { userId: user.id } });
      expect(orderCount).toBe(1);
    });
  });

  // ===========================================================================
  describe('Order ownership', () => {
    it("returns 404 for another user's order, and excludes it from the list", async () => {
      const owner = await registerUser();
      const intruder = await registerUser();
      await addToCart(owner.accessToken, { menuItemId: checkoutItem.id });
      const checkout = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/orders/${checkout.body.id}`)
        .set('Authorization', `Bearer ${intruder.accessToken}`);
      expect(detail.status).toBe(404);

      const status = await request(app.getHttpServer())
        .get(`/api/v1/orders/${checkout.body.id}/status`)
        .set('Authorization', `Bearer ${intruder.accessToken}`);
      expect(status.status).toBe(404);

      const list = await request(app.getHttpServer())
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${intruder.accessToken}`);
      expect(list.body.find((o: { id: string }) => o.id === checkout.body.id)).toBeUndefined();
    });

    it('requires authentication', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/orders');
      expect(res.status).toBe(401);
    });
  });

  // ===========================================================================
  describe('List / detail / status', () => {
    it('lists the caller own orders and supports a status filter', async () => {
      const { accessToken, user } = await registerUser();
      await addToCart(accessToken, { menuItemId: checkoutItem.id });
      const checkout = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });

      const list = await request(app.getHttpServer())
        .get('/api/v1/orders')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(list.status).toBe(200);
      expect(list.body.some((o: { id: string }) => o.id === checkout.body.id)).toBe(true);
      expect(list.body.every((o: { userId: string }) => o.userId === user.id)).toBe(true);

      const filtered = await request(app.getHttpServer())
        .get('/api/v1/orders')
        .query({ status: 'pending' })
        .set('Authorization', `Bearer ${accessToken}`);
      expect(filtered.status).toBe(200);
      expect(filtered.body.some((o: { id: string }) => o.id === checkout.body.id)).toBe(true);

      const empty = await request(app.getHttpServer())
        .get('/api/v1/orders')
        .query({ status: 'delivered' })
        .set('Authorization', `Bearer ${accessToken}`);
      expect(empty.body.find((o: { id: string }) => o.id === checkout.body.id)).toBeUndefined();
    });

    it('404s for an unknown order id', async () => {
      const { accessToken } = await registerUser();
      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${randomUUID()}`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================
  describe('Delivery vs pickup validation', () => {
    it('requires a delivery address for DELIVERY orders', async () => {
      const { accessToken } = await registerUser();
      await addToCart(accessToken, { menuItemId: checkoutItem.id });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'DELIVERY', paymentMethod: 'CASH' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('DELIVERY_ADDRESS_REQUIRED');
    });

    it('snapshots the provided address and charges the distance-based delivery fee for DELIVERY', async () => {
      const { accessToken } = await registerUser();
      await addToCart(accessToken, { menuItemId: checkoutItem.id });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          deliveryMethod: 'DELIVERY',
          paymentMethod: 'CASH',
          deliveryAddress: deliveryAddressWithPin,
        });
      expect(res.status).toBe(201);
      expect(res.body.deliveryFee).toBeGreaterThan(0);
      expect(res.body.deliveryAddress).toMatchObject(deliveryAddress);
      expect(res.body.deliveryTier).toMatchObject({
        minDistanceKm: '0.00',
        maxDistanceKm: '15.00',
      });
      expect(res.body.deliveryDistanceMeters).toBe(5_000);
      // Order response contract: a DELIVERY checkout must report
      // deliveryMethod: 'DELIVERY' (never fall back to the client default).
      expect(res.body.deliveryMethod).toBe('DELIVERY');
      expect(res.body.paymentStatus).toBe('PENDING');
    });

    it('snapshots latitude/longitude from the checkout payload and exposes them as nullable on read (VO2.3)', async () => {
      const { accessToken } = await registerUser();
      await addToCart(accessToken, { menuItemId: checkoutItem.id });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          deliveryMethod: 'DELIVERY',
          paymentMethod: 'CASH',
          deliveryAddress: deliveryAddressWithPin,
        });
      expect(res.status).toBe(201);
      expect(res.body.deliveryAddress).toMatchObject({
        ...deliveryAddress,
        latitude: 30.0444,
        longitude: 31.2357,
      });

      // Editing the saved address afterwards must never change the
      // already-created order's snapshot — there is no saved-Address FK on
      // Order to begin with (deliveryAddressJson is a plain copy), so this
      // just re-reads the order to confirm the coordinates persisted as-is.
      const detail = await request(app.getHttpServer())
        .get(`/api/v1/orders/${res.body.id}`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(detail.status).toBe(200);
      expect(detail.body.deliveryAddress.latitude).toBe(30.0444);
      expect(detail.body.deliveryAddress.longitude).toBe(31.2357);
    });

    it('rejects a DELIVERY checkout when the payload omits latitude/longitude (distance pricing requires a pin)', async () => {
      const { accessToken } = await registerUser();
      await addToCart(accessToken, { menuItemId: checkoutItem.id });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'DELIVERY', paymentMethod: 'CASH', deliveryAddress });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('DELIVERY_COORDINATES_REQUIRED');
    });

    it('rejects an out-of-range latitude/longitude on checkout (VO2.3)', async () => {
      const { accessToken } = await registerUser();
      await addToCart(accessToken, { menuItemId: checkoutItem.id });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          deliveryMethod: 'DELIVERY',
          paymentMethod: 'CASH',
          deliveryAddress: { ...deliveryAddress, latitude: 999, longitude: 31.2357 },
        });
      expect(res.status).toBe(400);
    });

    it('rejects a DELIVERY checkout beyond the deliverable range (OUTSIDE_DELIVERY_RANGE)', async () => {
      mockGoogleRoutesService.computeRoute.mockResolvedValueOnce({
        distanceMeters: 30_500,
        durationSeconds: 2400,
      });
      const { accessToken } = await registerUser();
      await addToCart(accessToken, { menuItemId: checkoutItem.id });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          deliveryMethod: 'DELIVERY',
          paymentMethod: 'CASH',
          deliveryAddress: deliveryAddressWithPin,
        });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('OUTSIDE_DELIVERY_RANGE');
    });

    it('zeroes the delivery fee and ignores address for PICKUP', async () => {
      const { accessToken } = await registerUser();
      await addToCart(accessToken, { menuItemId: checkoutItem.id });

      const res = await request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ deliveryMethod: 'PICKUP', paymentMethod: 'CASH' });
      expect(res.status).toBe(201);
      expect(res.body.deliveryFee).toBe(0);
      // PICKUP is untouched by VO2.3 — no latitude/longitude keys are added.
      expect(res.body.deliveryAddress).toEqual({ type: 'PICKUP' });
    });
  });
});
