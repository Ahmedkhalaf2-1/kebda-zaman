import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

/**
 * Phase 3 integration tests: public catalog endpoints against the live
 * Docker PostgreSQL instance, using the Phase 1 seed data (6 categories,
 * 10 menu items) plus a few ephemeral fixtures created here to exercise
 * active/available filtering. Every fixture row is deleted in afterAll.
 */
describe('Catalog (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const cleanupCategoryIds: string[] = [];

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
  });

  afterAll(async () => {
    if (cleanupCategoryIds.length > 0) {
      // Cascades to MenuItem/ItemVariant/AddonGroup/Addon created under these categories.
      await prisma.menuItem.deleteMany({ where: { categoryId: { in: cleanupCategoryIds } } });
      await prisma.category.deleteMany({ where: { id: { in: cleanupCategoryIds } } });
    }
    await app.close();
  });

  describe('GET /categories', () => {
    it('returns only active categories, ordered by displayOrder', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/categories');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(6); // Phase 1 seed
      const orders = res.body.map((c: { displayOrder: number }) => c.displayOrder);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
      expect(res.body[0]).toMatchObject({
        id: expect.any(String),
        nameAr: expect.any(String),
        nameEn: expect.any(String),
        displayOrder: expect.any(Number),
      });
    });

    it('excludes an inactive category', async () => {
      const inactive = await prisma.category.create({
        data: { nameAr: 'غير نشط', nameEn: 'Inactive Category', isActive: false },
      });
      cleanupCategoryIds.push(inactive.id);

      const res = await request(app.getHttpServer()).get('/api/v1/categories');
      expect(res.body.some((c: { id: string }) => c.id === inactive.id)).toBe(false);
    });
  });

  describe('GET /categories/:id', () => {
    it('returns a single category', async () => {
      const list = await request(app.getHttpServer()).get('/api/v1/categories');
      const target = list.body[0];

      const res = await request(app.getHttpServer()).get(`/api/v1/categories/${target.id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(target.id);
    });

    it('returns 404 for a well-formed but unknown id', async () => {
      const res = await request(app.getHttpServer()).get(`/api/v1/categories/${randomUUID()}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('CATEGORY_NOT_FOUND');
    });

    it('returns 400 for a malformed id', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/categories/not-a-uuid');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /menu', () => {
    it('returns items with nested variants and addonGroups/addons as numbers, not strings', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/menu');
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(10); // Phase 1 seed

      const withVariant = res.body.find((i: { variants: unknown[] }) => i.variants.length > 0);
      expect(withVariant).toBeDefined();
      expect(typeof withVariant.basePrice).toBe('number');
      expect(typeof withVariant.variants[0].priceDelta).toBe('number');

      const withAddon = res.body.find(
        (i: { addonGroups: { addons: unknown[] }[] }) =>
          i.addonGroups.length > 0 && i.addonGroups[0].addons.length > 0,
      );
      expect(withAddon).toBeDefined();
      expect(typeof withAddon.addonGroups[0].addons[0].price).toBe('number');
    });

    it('filters by categoryId', async () => {
      const categories = await request(app.getHttpServer()).get('/api/v1/categories');
      const categoryId = categories.body[0].id;

      const res = await request(app.getHttpServer()).get('/api/v1/menu').query({ categoryId });
      expect(res.status).toBe(200);
      expect(res.body.every((i: { categoryId: string }) => i.categoryId === categoryId)).toBe(true);
    });

    it('rejects a malformed categoryId', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/menu')
        .query({ categoryId: 'not-a-uuid' });
      expect(res.status).toBe(400);
    });

    it('rejects an out-of-range limit', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/menu').query({ limit: 1000 });
      expect(res.status).toBe(400);
    });

    it('excludes an unavailable item', async () => {
      const category = await prisma.category.create({
        data: { nameAr: 'فئة اختبار', nameEn: 'Filter Test Category' },
      });
      cleanupCategoryIds.push(category.id);
      const unavailable = await prisma.menuItem.create({
        data: {
          categoryId: category.id,
          nameAr: 'غير متاح',
          nameEn: 'Unavailable Item',
          descriptionAr: 'وصف',
          descriptionEn: 'description',
          basePrice: new Prisma.Decimal('10.00'),
          imageUrl: 'https://example.test/img.png',
          isAvailable: false,
        },
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/menu')
        .query({ categoryId: category.id });
      expect(res.body.some((i: { id: string }) => i.id === unavailable.id)).toBe(false);
    });

    it('excludes items under an inactive category', async () => {
      const category = await prisma.category.create({
        data: { nameAr: 'فئة غير نشطة', nameEn: 'Inactive Parent', isActive: false },
      });
      cleanupCategoryIds.push(category.id);
      const item = await prisma.menuItem.create({
        data: {
          categoryId: category.id,
          nameAr: 'صنف',
          nameEn: 'Item Under Inactive Category',
          descriptionAr: 'وصف',
          descriptionEn: 'description',
          basePrice: new Prisma.Decimal('10.00'),
          imageUrl: 'https://example.test/img.png',
        },
      });

      const res = await request(app.getHttpServer()).get('/api/v1/menu');
      expect(res.body.some((i: { id: string }) => i.id === item.id)).toBe(false);
    });
  });

  describe('GET /menu/items/:id', () => {
    it('returns the full item with variants and addonGroups', async () => {
      const list = await request(app.getHttpServer()).get('/api/v1/menu');
      const target = list.body.find(
        (i: { variants: unknown[]; addonGroups: unknown[] }) =>
          i.variants.length > 0 && i.addonGroups.length > 0,
      );
      expect(target).toBeDefined();

      const res = await request(app.getHttpServer()).get(`/api/v1/menu/items/${target.id}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(target.id);
      expect(res.body.variants.length).toBeGreaterThan(0);
      expect(res.body.addonGroups.length).toBeGreaterThan(0);
      expect(res.body.addonGroups[0]).toMatchObject({
        titleAr: expect.any(String),
        titleEn: expect.any(String),
        isRequired: expect.any(Boolean),
        minSelect: expect.any(Number),
        maxSelect: expect.any(Number),
      });
    });

    it('returns 404 for an unknown item', async () => {
      const res = await request(app.getHttpServer()).get(`/api/v1/menu/items/${randomUUID()}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('MENU_ITEM_NOT_FOUND');
    });

    it('returns compareAtPrice as a JSON number, and null metadata fields as null', async () => {
      const category = await prisma.category.create({
        data: { nameAr: 'فئة اختبار الميتاداتا', nameEn: 'Metadata Test Category' },
      });
      cleanupCategoryIds.push(category.id);
      const withMetadata = await prisma.menuItem.create({
        data: {
          categoryId: category.id,
          nameAr: 'صنف مخفض',
          nameEn: 'Discounted Item',
          descriptionAr: 'وصف',
          descriptionEn: 'description',
          basePrice: new Prisma.Decimal('20.00'),
          compareAtPrice: new Prisma.Decimal('25.00'),
          calories: 450,
          badge: 'BESTSELLER',
          imageUrl: 'https://example.test/img.png',
        },
      });
      const plain = await prisma.menuItem.create({
        data: {
          categoryId: category.id,
          nameAr: 'صنف عادي',
          nameEn: 'Plain Item',
          descriptionAr: 'وصف',
          descriptionEn: 'description',
          basePrice: new Prisma.Decimal('10.00'),
          imageUrl: 'https://example.test/img.png',
        },
      });

      const withMetadataRes = await request(app.getHttpServer()).get(
        `/api/v1/menu/items/${withMetadata.id}`,
      );
      expect(withMetadataRes.status).toBe(200);
      expect(typeof withMetadataRes.body.compareAtPrice).toBe('number');
      expect(withMetadataRes.body.compareAtPrice).toBe(25);
      expect(withMetadataRes.body.calories).toBe(450);
      expect(withMetadataRes.body.badge).toBe('BESTSELLER');

      const plainRes = await request(app.getHttpServer()).get(`/api/v1/menu/items/${plain.id}`);
      expect(plainRes.status).toBe(200);
      expect(plainRes.body.compareAtPrice).toBeNull();
      expect(plainRes.body.calories).toBeNull();
      expect(plainRes.body.badge).toBeNull();
    });
  });

  describe('GET /menu/items/:id — oftenOrderedWith', () => {
    async function makeItem(
      categoryId: string,
      overrides: Partial<Prisma.MenuItemUncheckedCreateInput> = {},
    ) {
      return prisma.menuItem.create({
        data: {
          categoryId,
          nameAr: `صنف ${randomUUID()}`,
          nameEn: `Item ${randomUUID()}`,
          descriptionAr: 'وصف',
          descriptionEn: 'description',
          basePrice: new Prisma.Decimal('10.00'),
          imageUrl: 'https://example.test/img.png',
          ...overrides,
        },
      });
    }

    it('returns oftenOrderedWith in configured order, with only the approved summary fields, excluding unavailable/soft-deleted/inactive-category/deleted-category recommendations', async () => {
      const category = await prisma.category.create({
        data: { nameAr: 'فئة التوصيات', nameEn: 'Recommendations Category' },
      });
      cleanupCategoryIds.push(category.id);
      const inactiveCategory = await prisma.category.create({
        data: { nameAr: 'فئة معطلة', nameEn: 'Inactive Rec Category', isActive: false },
      });
      cleanupCategoryIds.push(inactiveCategory.id);
      const deletedCategory = await prisma.category.create({
        data: { nameAr: 'فئة محذوفة', nameEn: 'Deleted Rec Category', deletedAt: new Date() },
      });
      cleanupCategoryIds.push(deletedCategory.id);

      const target = await makeItem(category.id);
      const validA = await makeItem(category.id, {
        compareAtPrice: new Prisma.Decimal('15.00'),
        calories: 300,
        badge: 'BESTSELLER',
      });
      const validB = await makeItem(category.id);
      const unavailable = await makeItem(category.id, { isAvailable: false });
      const softDeleted = await makeItem(category.id, { deletedAt: new Date() });
      const underInactiveCategory = await makeItem(inactiveCategory.id);
      const underDeletedCategory = await makeItem(deletedCategory.id);

      await prisma.menuItemRecommendation.createMany({
        data: [
          { menuItemId: target.id, recommendedMenuItemId: validA.id, displayOrder: 0 },
          { menuItemId: target.id, recommendedMenuItemId: unavailable.id, displayOrder: 1 },
          { menuItemId: target.id, recommendedMenuItemId: validB.id, displayOrder: 2 },
          { menuItemId: target.id, recommendedMenuItemId: softDeleted.id, displayOrder: 3 },
          {
            menuItemId: target.id,
            recommendedMenuItemId: underInactiveCategory.id,
            displayOrder: 4,
          },
          {
            menuItemId: target.id,
            recommendedMenuItemId: underDeletedCategory.id,
            displayOrder: 5,
          },
        ],
      });

      const res = await request(app.getHttpServer()).get(`/api/v1/menu/items/${target.id}`);
      expect(res.status).toBe(200);
      expect(res.body.oftenOrderedWith.map((i: { id: string }) => i.id)).toEqual([
        validA.id,
        validB.id,
      ]);

      const summary = res.body.oftenOrderedWith[0];
      expect(Object.keys(summary).sort()).toEqual(
        [
          'id',
          'categoryId',
          'nameAr',
          'nameEn',
          'descriptionAr',
          'descriptionEn',
          'basePrice',
          'compareAtPrice',
          'calories',
          'badge',
          'imageUrl',
          'isAvailable',
          'isPopular',
        ].sort(),
      );
      expect(typeof summary.compareAtPrice).toBe('number');
      expect(summary.compareAtPrice).toBe(15);
      expect(summary.badge).toBe('BESTSELLER');
    });

    it('returns [] when all recommendations are filtered out', async () => {
      const category = await prisma.category.create({
        data: { nameAr: 'فئة فارغة', nameEn: 'Empty Recs Category' },
      });
      cleanupCategoryIds.push(category.id);
      const target = await makeItem(category.id);
      const unavailable = await makeItem(category.id, { isAvailable: false });
      await prisma.menuItemRecommendation.create({
        data: { menuItemId: target.id, recommendedMenuItemId: unavailable.id, displayOrder: 0 },
      });

      const res = await request(app.getHttpServer()).get(`/api/v1/menu/items/${target.id}`);
      expect(res.status).toBe(200);
      expect(res.body.oftenOrderedWith).toEqual([]);
    });
  });

  describe('Public list/search/featured stay lightweight', () => {
    it('list, search, and featured responses never include oftenOrderedWith', async () => {
      const list = await request(app.getHttpServer()).get('/api/v1/menu');
      expect(list.body.length).toBeGreaterThan(0);
      expect(list.body.every((i: object) => !('oftenOrderedWith' in i))).toBe(true);

      const search = await request(app.getHttpServer())
        .get('/api/v1/menu/search')
        .query({ q: 'kebda' });
      expect(search.body.length).toBeGreaterThan(0);
      expect(search.body.every((i: object) => !('oftenOrderedWith' in i))).toBe(true);

      const featured = await request(app.getHttpServer()).get('/api/v1/home/featured');
      expect(featured.body.featured.length).toBeGreaterThan(0);
      expect(featured.body.featured.every((i: object) => !('oftenOrderedWith' in i))).toBe(true);
    });
  });

  describe('GET /menu/search', () => {
    it('matches by English name (case-insensitive, partial)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/menu/search')
        .query({ q: 'kebda' });
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(
        res.body.every((i: { nameEn: string }) => i.nameEn.toLowerCase().includes('kebda')),
      ).toBe(true);
    });

    it('returns an empty array for a query with no matches', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/menu/search')
        .query({ q: 'zzzznonexistentzzzz' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('rejects a missing q', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/menu/search');
      expect(res.status).toBe(400);
    });

    it('rejects an empty q', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/menu/search').query({ q: '' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /home/featured', () => {
    it('returns featured items and categories', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/home/featured');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.featured)).toBe(true);
      expect(Array.isArray(res.body.categories)).toBe(true);
      expect(res.body.categories.length).toBeGreaterThanOrEqual(6);
      expect(res.body.featured.every((i: { isPopular: boolean }) => i.isPopular)).toBe(true);
    });
  });

  describe('Public access (no auth required)', () => {
    it('serves catalog routes without an Authorization header', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/categories');
      expect(res.status).toBe(200);
    });
  });
});
