import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { AuthService } from '../src/modules/auth/auth.service';
import { PricingService } from '../src/modules/pricing/pricing.service';

const D = (v: string) => new Prisma.Decimal(v);

describe('Cart & Pricing (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let pricingService: PricingService;
  let authService: AuthService;

  let categoryId: string;
  let simpleItem: { id: string };
  let roundingItem: { id: string };
  let itemWithOptions: {
    id: string;
    variantSmall: string;
    variantLarge: string;
    variantInactive: string;
    extra1: string;
    extra2: string;
    extra4: string;
  };
  let unavailableItem: { id: string };
  let requiredAddonItem: { id: string; r1: string; r2: string };

  const promoCodes = {
    percent10: 'PHASE4-PERCENT10',
    percentCapped: 'PHASE4-PERCENTCAP',
    fixed20: 'PHASE4-FIXED20',
    minOrder: 'PHASE4-MINORDER',
    expired: 'PHASE4-EXPIRED',
    inactive: 'PHASE4-INACTIVE',
  };

  let accessToken: string;
  let userId: string;
  const cleanupUserIds: string[] = [];

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
    pricingService = app.get(PricingService);
    authService = app.get(AuthService);

    const category = await prisma.category.create({
      data: { nameAr: 'فئة تسعير', nameEn: 'Phase 4 Pricing Category' },
    });
    categoryId = category.id;

    simpleItem = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف بسيط',
        nameEn: 'Simple Item',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: D('42.00'),
        imageUrl: 'https://example.test/img.png',
      },
    });

    roundingItem = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف تقريب',
        nameEn: 'Rounding Item',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: D('10.10'),
        imageUrl: 'https://example.test/img.png',
      },
    });

    unavailableItem = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'غير متاح',
        nameEn: 'Unavailable Item',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: D('50.00'),
        imageUrl: 'https://example.test/img.png',
        isAvailable: false,
      },
    });

    const withOptions = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف بخيارات',
        nameEn: 'Item With Options',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: D('100.00'),
        imageUrl: 'https://example.test/img.png',
        variants: {
          create: [
            {
              nameAr: 'صغير',
              nameEn: 'Small',
              priceDelta: D('0'),
              isDefault: true,
              isActive: true,
            },
            {
              nameAr: 'كبير',
              nameEn: 'Large',
              priceDelta: D('20.00'),
              isDefault: false,
              isActive: true,
            },
            {
              nameAr: 'غير نشط',
              nameEn: 'Inactive',
              priceDelta: D('99.00'),
              isDefault: false,
              isActive: false,
            },
          ],
        },
        addonGroups: {
          create: [
            {
              titleAr: 'إضافات',
              titleEn: 'Toppings',
              isRequired: false,
              minSelect: 0,
              maxSelect: 2,
              addons: {
                create: [
                  { nameAr: 'إضافة 1', nameEn: 'Extra 1', price: D('5.00'), isAvailable: true },
                  { nameAr: 'إضافة 2', nameEn: 'Extra 2', price: D('3.00'), isAvailable: true },
                  { nameAr: 'إضافة 3', nameEn: 'Extra 3', price: D('10.00'), isAvailable: false },
                  { nameAr: 'إضافة 4', nameEn: 'Extra 4', price: D('1.00'), isAvailable: true },
                ],
              },
            },
          ],
        },
      },
      include: { variants: true, addonGroups: { include: { addons: true } } },
    });
    itemWithOptions = {
      id: withOptions.id,
      variantSmall: withOptions.variants.find((v) => v.nameEn === 'Small')!.id,
      variantLarge: withOptions.variants.find((v) => v.nameEn === 'Large')!.id,
      variantInactive: withOptions.variants.find((v) => v.nameEn === 'Inactive')!.id,
      extra1: withOptions.addonGroups[0].addons.find((a) => a.nameEn === 'Extra 1')!.id,
      extra2: withOptions.addonGroups[0].addons.find((a) => a.nameEn === 'Extra 2')!.id,
      extra4: withOptions.addonGroups[0].addons.find((a) => a.nameEn === 'Extra 4')!.id,
    };

    const withRequired = await prisma.menuItem.create({
      data: {
        categoryId,
        nameAr: 'صنف بإضافة إلزامية',
        nameEn: 'Item With Required Addon',
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: D('30.00'),
        imageUrl: 'https://example.test/img.png',
        addonGroups: {
          create: [
            {
              titleAr: 'اختيار إلزامي',
              titleEn: 'Required Choice',
              isRequired: true,
              minSelect: 1,
              maxSelect: 1,
              addons: {
                create: [
                  { nameAr: 'خيار 1', nameEn: 'Choice 1', price: D('0'), isAvailable: true },
                  { nameAr: 'خيار 2', nameEn: 'Choice 2', price: D('2.50'), isAvailable: true },
                ],
              },
            },
          ],
        },
      },
      include: { addonGroups: { include: { addons: true } } },
    });
    requiredAddonItem = {
      id: withRequired.id,
      r1: withRequired.addonGroups[0].addons.find((a) => a.nameEn === 'Choice 1')!.id,
      r2: withRequired.addonGroups[0].addons.find((a) => a.nameEn === 'Choice 2')!.id,
    };

    const now = new Date();
    await prisma.promoCode.createMany({
      data: [
        { code: promoCodes.percent10, discountType: 'PERCENT', value: D('10') },
        {
          code: promoCodes.percentCapped,
          discountType: 'PERCENT',
          value: D('50'),
          maxDiscountAmount: D('20.00'),
        },
        { code: promoCodes.fixed20, discountType: 'FIXED', value: D('20.00') },
        {
          code: promoCodes.minOrder,
          discountType: 'FIXED',
          value: D('5.00'),
          minOrderAmount: D('500.00'),
        },
        {
          code: promoCodes.expired,
          discountType: 'FIXED',
          value: D('5.00'),
          expiresAt: new Date(now.getTime() - 86_400_000),
        },
        { code: promoCodes.inactive, discountType: 'FIXED', value: D('5.00'), isActive: false },
      ],
    });

    const registered = await authService.register(
      {
        name: 'Cart Test User',
        email: `cart-test-${randomUUID()}@phase4.local`,
        password: 'correcthorsebattery',
      },
      {},
    );
    accessToken = registered.accessToken;
    userId = registered.user.id;
    cleanupUserIds.push(registered.user.id);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    await prisma.promoCode.deleteMany({ where: { code: { in: Object.values(promoCodes) } } });
    await prisma.menuItem.deleteMany({ where: { categoryId } });
    await prisma.category.delete({ where: { id: categoryId } });
    await app.close();
  });

  // ===========================================================================
  describe('PricingService.priceLines', () => {
    it('prices a base item with no variant/addons', async () => {
      const { lines, subtotal } = await pricingService.priceLines([
        { menuItemId: simpleItem.id, addonIds: [], quantity: 1 },
      ]);
      expect(lines[0].unitPrice.toString()).toBe('42');
      expect(lines[0].lineTotal.toString()).toBe('42');
      expect(subtotal.toString()).toBe('42');
    });

    it('applies a variant price delta', async () => {
      const { lines } = await pricingService.priceLines([
        {
          menuItemId: itemWithOptions.id,
          variantId: itemWithOptions.variantLarge,
          addonIds: [],
          quantity: 1,
        },
      ]);
      expect(lines[0].unitPrice.toString()).toBe('120');
    });

    it('applies addon prices on top of base + variant', async () => {
      const { lines } = await pricingService.priceLines([
        {
          menuItemId: itemWithOptions.id,
          variantId: itemWithOptions.variantSmall,
          addonIds: [itemWithOptions.extra1, itemWithOptions.extra2],
          quantity: 1,
        },
      ]);
      // 100 (base) + 0 (small) + 5 + 3 (addons)
      expect(lines[0].unitPrice.toString()).toBe('108');
    });

    it('sums multiple distinct items into one subtotal', async () => {
      const { subtotal } = await pricingService.priceLines([
        { menuItemId: simpleItem.id, addonIds: [], quantity: 1 },
        {
          menuItemId: itemWithOptions.id,
          variantId: itemWithOptions.variantSmall,
          addonIds: [],
          quantity: 1,
        },
      ]);
      expect(subtotal.toString()).toBe('142'); // 42 + 100
    });

    it('multiplies unit price by quantity for the line total', async () => {
      const { lines } = await pricingService.priceLines([
        { menuItemId: simpleItem.id, addonIds: [], quantity: 3 },
      ]);
      expect(lines[0].lineTotal.toString()).toBe('126'); // 42 * 3
    });

    it('rejects a variant that does not belong to the item (or is inactive)', async () => {
      await expect(
        pricingService.priceLines([
          { menuItemId: itemWithOptions.id, variantId: randomUUID(), addonIds: [], quantity: 1 },
        ]),
      ).rejects.toMatchObject({ response: { code: 'INVALID_VARIANT' } });

      await expect(
        pricingService.priceLines([
          {
            menuItemId: itemWithOptions.id,
            variantId: itemWithOptions.variantInactive,
            addonIds: [],
            quantity: 1,
          },
        ]),
      ).rejects.toMatchObject({ response: { code: 'INVALID_VARIANT' } });
    });

    it('rejects an addon that does not belong to the item (or is unavailable)', async () => {
      await expect(
        pricingService.priceLines([
          { menuItemId: itemWithOptions.id, addonIds: [randomUUID()], quantity: 1 },
        ]),
      ).rejects.toMatchObject({ response: { code: 'INVALID_ADDON_SELECTION' } });
    });

    it('enforces an addon group maxSelect', async () => {
      await expect(
        pricingService.priceLines([
          {
            menuItemId: itemWithOptions.id,
            addonIds: [itemWithOptions.extra1, itemWithOptions.extra2, itemWithOptions.extra4],
            quantity: 1,
          },
        ]),
      ).rejects.toMatchObject({ response: { code: 'INVALID_ADDON_SELECTION' } });
    });

    it('enforces a required addon group minSelect', async () => {
      await expect(
        pricingService.priceLines([
          { menuItemId: requiredAddonItem.id, addonIds: [], quantity: 1 },
        ]),
      ).rejects.toMatchObject({ response: { code: 'INVALID_ADDON_SELECTION' } });

      const { lines } = await pricingService.priceLines([
        { menuItemId: requiredAddonItem.id, addonIds: [requiredAddonItem.r2], quantity: 1 },
      ]);
      expect(lines[0].unitPrice.toString()).toBe('32.5'); // 30 + 2.50
    });

    it('rejects an unavailable item', async () => {
      await expect(
        pricingService.priceLines([{ menuItemId: unavailableItem.id, addonIds: [], quantity: 1 }]),
      ).rejects.toMatchObject({ response: { code: 'ITEM_UNAVAILABLE' } });
    });
  });

  // ===========================================================================
  describe('PricingService.evaluatePromo', () => {
    it('computes a PERCENT discount', async () => {
      const { discount } = await pricingService.evaluatePromo(
        promoCodes.percent10,
        D('100.00'),
        userId,
      );
      expect(discount.toString()).toBe('10');
    });

    it('computes a FIXED discount, capped at the subtotal', async () => {
      const full = await pricingService.evaluatePromo(promoCodes.fixed20, D('100.00'), userId);
      expect(full.discount.toString()).toBe('20');

      const capped = await pricingService.evaluatePromo(promoCodes.fixed20, D('5.00'), userId);
      expect(capped.discount.toString()).toBe('5'); // min(20, 5)
    });

    it('caps a PERCENT discount at maxDiscountAmount', async () => {
      const { discount } = await pricingService.evaluatePromo(
        promoCodes.percentCapped,
        D('100.00'),
        userId,
      );
      // 50% of 100 = 50, capped at 20
      expect(discount.toString()).toBe('20');
    });

    it('rejects an expired promo', async () => {
      await expect(
        pricingService.evaluatePromo(promoCodes.expired, D('100.00'), userId),
      ).rejects.toMatchObject({ response: { code: 'PROMO_EXPIRED' } });
    });

    it('rejects a promo below its minimum order amount', async () => {
      await expect(
        pricingService.evaluatePromo(promoCodes.minOrder, D('10.00'), userId),
      ).rejects.toMatchObject({ response: { code: 'PROMO_MIN_ORDER' } });
    });

    it('rejects an inactive promo', async () => {
      await expect(
        pricingService.evaluatePromo(promoCodes.inactive, D('100.00'), userId),
      ).rejects.toMatchObject({ response: { code: 'PROMO_INVALID' } });
    });

    it('rejects an unknown promo code', async () => {
      await expect(
        pricingService.evaluatePromo('THIS-CODE-DOES-NOT-EXIST', D('100.00'), userId),
      ).rejects.toMatchObject({ response: { code: 'PROMO_NOT_FOUND' } });
    });
  });

  // ===========================================================================
  describe('PricingService.priceCart (tax / delivery / pickup / rounding)', () => {
    it('computes tax with half-up rounding to 2dp', async () => {
      const settings = await prisma.restaurantSettings.findFirstOrThrow({
        where: { singleton: true },
      });
      const result = await pricingService.priceCart(
        [{ menuItemId: roundingItem.id, addonIds: [], quantity: 1 }],
        settings,
        'DELIVERY',
        undefined,
        undefined,
        userId,
      );
      // subtotal 10.10 * 14% = 1.414 -> rounds to 1.41
      expect(result.subtotal.toString()).toBe('10.1');
      expect(result.tax.toString()).toBe('1.41');
    });

    it('applies the settings delivery fee for DELIVERY', async () => {
      const settings = await prisma.restaurantSettings.findFirstOrThrow({
        where: { singleton: true },
      });
      const result = await pricingService.priceCart(
        [{ menuItemId: simpleItem.id, addonIds: [], quantity: 1 }],
        settings,
        'DELIVERY',
        undefined,
        undefined,
        userId,
      );
      expect(result.deliveryFee.toString()).toBe(settings.deliveryFee.toString());
    });

    it('zeroes the delivery fee for PICKUP', async () => {
      const settings = await prisma.restaurantSettings.findFirstOrThrow({
        where: { singleton: true },
      });
      const result = await pricingService.priceCart(
        [{ menuItemId: simpleItem.id, addonIds: [], quantity: 1 }],
        settings,
        'PICKUP',
        undefined,
        undefined,
        userId,
      );
      expect(result.deliveryFee.toString()).toBe('0');
    });

    it('computes totalAmount = discountedSubtotal + tax + deliveryFee', async () => {
      const settings = await prisma.restaurantSettings.findFirstOrThrow({
        where: { singleton: true },
      });
      const result = await pricingService.priceCart(
        [{ menuItemId: simpleItem.id, addonIds: [], quantity: 1 }],
        settings,
        'DELIVERY',
        promoCodes.percent10,
        undefined,
        userId,
      );
      // subtotal 42, discount 4.2, discountedSubtotal 37.8, tax = round(37.8*0.14,2)=5.29, delivery=settings
      const expectedDiscounted = D('42.00').minus('4.2');
      const expectedTax = expectedDiscounted
        .times(settings.taxRatePercent)
        .dividedBy(100)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      const expectedTotal = expectedDiscounted.plus(expectedTax).plus(settings.deliveryFee);
      expect(result.discount.toString()).toBe('4.2');
      expect(result.tax.toString()).toBe(expectedTax.toString());
      expect(result.totalAmount.toString()).toBe(expectedTotal.toString());
    });
  });

  // ===========================================================================
  describe('Cart HTTP endpoints', () => {
    let cartItemId: string;

    it('requires authentication', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/cart');
      expect(res.status).toBe(401);
    });

    it('GET /cart starts empty with settings-derived deliveryFee/taxRate', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.appliedPromo).toBeNull();
      expect(typeof res.body.deliveryFee).toBe('number');
      expect(typeof res.body.taxRate).toBe('number');
    });

    it('POST /cart/items adds a hydrated line and rejects client-sent price fields', async () => {
      const tampered = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          menuItemId: itemWithOptions.id,
          variantId: itemWithOptions.variantLarge,
          addonIds: [itemWithOptions.extra1],
          quantity: 2,
          unitPrice: 0.01,
          totalPrice: 0.01,
        });
      expect(tampered.status).toBe(400); // forbidNonWhitelisted rejects the extra price fields

      const res = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          menuItemId: itemWithOptions.id,
          variantId: itemWithOptions.variantLarge,
          addonIds: [itemWithOptions.extra1],
          quantity: 2,
        });
      expect(res.status).toBe(201);
      const item = res.body.items[0];
      expect(item.menuItem.id).toBe(itemWithOptions.id);
      expect(item.selectedVariant.id).toBe(itemWithOptions.variantLarge);
      expect(item.selectedAddons).toHaveLength(1);
      expect(item.quantity).toBe(2);
      // unitPrice = 100 + 20 + 5 = 125; totalPrice = 125 * 2 = 250
      expect(item.unitPrice).toBe(125);
      expect(item.totalPrice).toBe(250);
      cartItemId = item.id;
    });

    it('rejects an invalid selection on add (422) and an unavailable item (404)', async () => {
      const invalidAddon = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ menuItemId: itemWithOptions.id, addonIds: [randomUUID()], quantity: 1 });
      expect(invalidAddon.status).toBe(422);

      const unavailable = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ menuItemId: unavailableItem.id, quantity: 1 });
      expect(unavailable.status).toBe(404);
    });

    it('PUT /cart/items/:id updates quantity and recomputes totalPrice', async () => {
      const res = await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${cartItemId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ quantity: 3 });
      expect(res.status).toBe(200);
      const item = res.body.items.find((i: { id: string }) => i.id === cartItemId);
      expect(item.quantity).toBe(3);
      expect(item.totalPrice).toBe(375); // 125 * 3
    });

    it('PUT /cart/items/:id can clear addons via an explicit empty array', async () => {
      const res = await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${cartItemId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ addonIds: [] });
      expect(res.status).toBe(200);
      const item = res.body.items.find((i: { id: string }) => i.id === cartItemId);
      expect(item.selectedAddons).toEqual([]);
      expect(item.unitPrice).toBe(120); // 100 + 20, no addons
    });

    it('PUT /cart/items/:id returns 404 for another/unknown item id', async () => {
      const res = await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${randomUUID()}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ quantity: 1 });
      expect(res.status).toBe(404);
    });

    it('apply-promo / promo removal round-trip', async () => {
      const applied = await request(app.getHttpServer())
        .post('/api/v1/cart/apply-promo')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ code: promoCodes.percent10.toLowerCase() }); // lower-case in, normalized to upper internally
      expect(applied.status).toBe(201); // POST default (no @HttpCode override)
      expect(applied.body.appliedPromo.code).toBe(promoCodes.percent10);

      const removed = await request(app.getHttpServer())
        .delete('/api/v1/cart/promo')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(removed.status).toBe(200);
      expect(removed.body.appliedPromo).toBeNull();
    });

    it('apply-promo rejects an unknown code (404) and an expired code (422)', async () => {
      const unknown = await request(app.getHttpServer())
        .post('/api/v1/cart/apply-promo')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ code: 'NO-SUCH-CODE' });
      expect(unknown.status).toBe(404);

      const expired = await request(app.getHttpServer())
        .post('/api/v1/cart/apply-promo')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ code: promoCodes.expired });
      expect(expired.status).toBe(422);
    });

    it('POST /promos/validate prices the real cart and ignores the client-sent subtotal', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/promos/validate')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ code: promoCodes.fixed20, subtotal: 999999 });
      expect(res.status).toBe(201); // POST default (no @HttpCode override)
      expect(res.body).toMatchObject({ valid: true, discountType: 'FIXED', value: 20 });
      // Real cart subtotal at this point is 120 (single item, no addons, from the earlier test) — well under 999999.
      expect(res.body.computedDiscount).toBeLessThan(999999);
    });

    it('DELETE /cart/items/:id removes the line', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/cart/items/${cartItemId}`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items.find((i: { id: string }) => i.id === cartItemId)).toBeUndefined();
    });

    it('DELETE /cart empties the cart', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ menuItemId: simpleItem.id, quantity: 1 });

      const res = await request(app.getHttpServer())
        .delete('/api/v1/cart')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });

    it('allows a guest session to use the cart', async () => {
      const guest = await authService.guest({}, {});
      cleanupUserIds.push(guest.user.id);

      const res = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Authorization', `Bearer ${guest.accessToken}`);
      expect(res.status).toBe(200);
    });
  });

  // ===========================================================================
  describe('Graceful handling of a cart item that becomes unavailable', () => {
    it('GET /cart still succeeds and hydrates the stale line as isAvailable=false, without dropping it', async () => {
      const staleSourceItem = await prisma.menuItem.create({
        data: {
          categoryId,
          nameAr: 'صنف سيصبح غير متاح',
          nameEn: 'Item That Goes Stale',
          descriptionAr: 'وصف',
          descriptionEn: 'description',
          basePrice: D('77.00'),
          imageUrl: 'https://example.test/img.png',
        },
      });

      const added = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ menuItemId: staleSourceItem.id, quantity: 1 });
      expect(added.status).toBe(201);
      const staleCartItemId = added.body.items.find(
        (i: { menuItem: { id: string } }) => i.menuItem.id === staleSourceItem.id,
      ).id;

      // Simulate an admin disabling the item after it was already added to a cart.
      await prisma.menuItem.update({
        where: { id: staleSourceItem.id },
        data: { isAvailable: false },
      });

      const cartRes = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(cartRes.status).toBe(200); // must not 404/422 the whole cart

      const staleLine = cartRes.body.items.find((i: { id: string }) => i.id === staleCartItemId);
      expect(staleLine).toBeDefined(); // still present, not silently removed
      expect(staleLine.isAvailable).toBe(false);
      expect(staleLine.menuItem.isAvailable).toBe(false);
      expect(staleLine.unitPrice).toBe(0);
      expect(staleLine.totalPrice).toBe(0);

      // Mutations must still be strict: you cannot update a now-unavailable line.
      const update = await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${staleCartItemId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ quantity: 2 });
      expect(update.status).toBe(404);

      // The customer must still be able to remove the stale line.
      const removed = await request(app.getHttpServer())
        .delete(`/api/v1/cart/items/${staleCartItemId}`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(removed.status).toBe(200);
      expect(
        removed.body.items.find((i: { id: string }) => i.id === staleCartItemId),
      ).toBeUndefined();
    });
  });

  // ===========================================================================
  describe('GET /settings', () => {
    it('is public and returns the documented subset', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/settings');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        deliveryFee: expect.any(Number),
        taxRatePercent: expect.any(Number),
        minOrderAmount: expect.any(Number),
        isMaintenanceMode: expect.any(Boolean),
      });
      expect(res.body).toHaveProperty('workingHours');
    });
  });
});
