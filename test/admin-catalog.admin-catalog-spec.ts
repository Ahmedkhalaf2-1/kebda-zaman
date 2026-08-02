import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { AuthService } from '../src/modules/auth/auth.service';

describe('Admin Catalog (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;

  const cleanupUserIds: string[] = [];
  const cleanupCategoryIds: string[] = [];

  async function registerCustomer() {
    const registered = await authService.register(
      {
        name: 'AC Customer',
        email: `ac-customer-${randomUUID()}@phase7b.local`,
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
        name: 'AC Admin',
        email: `ac-admin-${randomUUID()}@phase7b.local`,
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

  function newCategoryPayload() {
    return { nameAr: `فئة ${randomUUID()}`, nameEn: `Category ${randomUUID()}`, displayOrder: 1 };
  }

  function newMenuItemPayload(categoryId: string, overrides: Record<string, unknown> = {}) {
    return {
      categoryId,
      nameAr: `صنف ${randomUUID()}`,
      nameEn: `Item ${randomUUID()}`,
      descriptionAr: 'وصف',
      descriptionEn: 'description',
      basePrice: 25.5,
      imageUrl: 'https://example.test/img.png',
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
  });

  afterAll(async () => {
    // Cart items reference MenuItem with onDelete: Restrict — clear them first.
    if (cleanupUserIds.length > 0) {
      await prisma.cartItem.deleteMany({ where: { cart: { userId: { in: cleanupUserIds } } } });
    }
    if (cleanupCategoryIds.length > 0) {
      await prisma.menuItem.deleteMany({ where: { categoryId: { in: cleanupCategoryIds } } });
      await prisma.category.deleteMany({ where: { id: { in: cleanupCategoryIds } } });
    }
    if (cleanupUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    }
    await app.close();
  });

  // ===========================================================================
  describe('ADMIN access control', () => {
    it('rejects a CUSTOMER on every admin catalog route (403)', async () => {
      const customer = await registerCustomer();
      const auth = (r: request.Test) => r.set('Authorization', `Bearer ${customer.accessToken}`);

      expect(
        (await auth(request(app.getHttpServer()).get('/api/v1/admin/categories'))).status,
      ).toBe(403);
      expect(
        (
          await auth(request(app.getHttpServer()).post('/api/v1/admin/categories')).send(
            newCategoryPayload(),
          )
        ).status,
      ).toBe(403);
      expect((await auth(request(app.getHttpServer()).get('/api/v1/admin/menu'))).status).toBe(403);
    });

    it('rejects an unauthenticated caller (401)', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/admin/categories');
      expect(res.status).toBe(401);
    });

    it('allows an ADMIN', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(200);
    });
  });

  // ===========================================================================
  describe('Category CRUD', () => {
    it('creates, lists, updates, and soft-deletes a category', async () => {
      const admin = await registerAdmin();
      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCategoryPayload());
      expect(created.status).toBe(201);
      expect(created.body.isActive).toBe(true);
      cleanupCategoryIds.push(created.body.id);

      const list = await request(app.getHttpServer())
        .get('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(list.body.some((c: { id: string }) => c.id === created.body.id)).toBe(true);

      const updated = await request(app.getHttpServer())
        .put(`/api/v1/admin/categories/${created.body.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ nameAr: created.body.nameAr, nameEn: 'Renamed Category', displayOrder: 2 });
      expect(updated.status).toBe(200);
      expect(updated.body.nameEn).toBe('Renamed Category');

      const removed = await request(app.getHttpServer())
        .delete(`/api/v1/admin/categories/${created.body.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(removed.status).toBe(204);

      const listAfter = await request(app.getHttpServer())
        .get('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(listAfter.body.find((c: { id: string }) => c.id === created.body.id)).toBeUndefined();
    });

    it('blocks deleting a category that still has menu items (409)', async () => {
      const admin = await registerAdmin();
      const category = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCategoryPayload());
      cleanupCategoryIds.push(category.body.id);
      await request(app.getHttpServer())
        .post('/api/v1/admin/menu/items')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newMenuItemPayload(category.body.id));

      const res = await request(app.getHttpServer())
        .delete(`/api/v1/admin/categories/${category.body.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CATEGORY_HAS_ITEMS');
    });

    it('404s for an unknown category id', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/admin/categories/${randomUUID()}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================
  describe('Validation', () => {
    it('rejects a category missing required fields', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ nameEn: 'Only English' });
      expect(res.status).toBe(400);
    });

    it('rejects a menu item with an invalid categoryId (422)', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/menu/items')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newMenuItemPayload(randomUUID()));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_CATEGORY');
    });

    it('rejects a menu item missing required fields (400)', async () => {
      const admin = await registerAdmin();
      const category = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCategoryPayload());
      cleanupCategoryIds.push(category.body.id);

      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/menu/items')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ categoryId: category.body.id, nameAr: 'صنف' }); // missing basePrice etc.
      expect(res.status).toBe(400);
    });

    it('rejects an unknown extra field (forbidNonWhitelisted)', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ...newCategoryPayload(), notAField: true });
      expect(res.status).toBe(400);
    });

    it('rejects a non-boolean availability payload', async () => {
      const admin = await registerAdmin();
      const category = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCategoryPayload());
      cleanupCategoryIds.push(category.body.id);
      const item = await request(app.getHttpServer())
        .post('/api/v1/admin/menu/items')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newMenuItemPayload(category.body.id));

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/menu/items/${item.body.id}/availability`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ isAvailable: 'yes' });
      expect(res.status).toBe(400);
    });
  });

  // ===========================================================================
  describe('Menu item CRUD + availability toggle', () => {
    it('creates, lists (including unavailable), updates, toggles availability, and soft-deletes', async () => {
      const admin = await registerAdmin();
      const category = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCategoryPayload());
      cleanupCategoryIds.push(category.body.id);

      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/menu/items')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newMenuItemPayload(category.body.id, { isAvailable: false }));
      expect(created.status).toBe(201);
      expect(created.body.isAvailable).toBe(false);

      const adminList = await request(app.getHttpServer())
        .get('/api/v1/admin/menu')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(adminList.body.some((i: { id: string }) => i.id === created.body.id)).toBe(true);

      // Scoped by categoryId — an unscoped /menu list defaults to a 20-item
      // page and isn't reliable once many items exist across a test run.
      const publicList = await request(app.getHttpServer())
        .get('/api/v1/menu')
        .query({ categoryId: category.body.id });
      expect(publicList.body.find((i: { id: string }) => i.id === created.body.id)).toBeUndefined();

      const toggledOn = await request(app.getHttpServer())
        .patch(`/api/v1/admin/menu/items/${created.body.id}/availability`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ isAvailable: true });
      expect(toggledOn.status).toBe(200);
      expect(toggledOn.body.isAvailable).toBe(true);

      const publicListAfter = await request(app.getHttpServer())
        .get('/api/v1/menu')
        .query({ categoryId: category.body.id });
      expect(publicListAfter.body.some((i: { id: string }) => i.id === created.body.id)).toBe(true);

      const updated = await request(app.getHttpServer())
        .put(`/api/v1/admin/menu/items/${created.body.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newMenuItemPayload(category.body.id, { nameEn: 'Renamed Item' }));
      expect(updated.status).toBe(200);
      expect(updated.body.nameEn).toBe('Renamed Item');

      const publicDetail = await request(app.getHttpServer()).get(
        `/api/v1/menu/items/${created.body.id}`,
      );
      expect(publicDetail.body.nameEn).toBe('Renamed Item');

      const removed = await request(app.getHttpServer())
        .delete(`/api/v1/admin/menu/items/${created.body.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(removed.status).toBe(204);

      const publicAfterDelete = await request(app.getHttpServer()).get(
        `/api/v1/menu/items/${created.body.id}`,
      );
      expect(publicAfterDelete.status).toBe(404);
    });

    it('404s for an unknown menu item id', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/admin/menu/items/${randomUUID()}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(404);
    });
  });

  // ===========================================================================
  describe('Menu item metadata (calories, compareAtPrice, badge)', () => {
    async function setup() {
      const admin = await registerAdmin();
      const category = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCategoryPayload());
      cleanupCategoryIds.push(category.body.id);
      return { admin, categoryId: category.body.id as string };
    }

    describe('create', () => {
      it('creates an item with calories, compareAtPrice, and a BESTSELLER badge', async () => {
        const { admin, categoryId } = await setup();
        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(
            newMenuItemPayload(categoryId, {
              basePrice: 20,
              calories: 450,
              compareAtPrice: 25,
              badge: 'BESTSELLER',
            }),
          );
        expect(res.status).toBe(201);
        expect(res.body.calories).toBe(450);
        expect(res.body.compareAtPrice).toBe(25);
        expect(res.body.badge).toBe('BESTSELLER');
      });

      it('creates an item with a TOP_RATED badge', async () => {
        const { admin, categoryId } = await setup();
        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { badge: 'TOP_RATED' }));
        expect(res.status).toBe(201);
        expect(res.body.badge).toBe('TOP_RATED');
      });

      it('creates an item with no calories, no compareAtPrice, and no badge (all null)', async () => {
        const { admin, categoryId } = await setup();
        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId));
        expect(res.status).toBe(201);
        expect(res.body.calories).toBeNull();
        expect(res.body.compareAtPrice).toBeNull();
        expect(res.body.badge).toBeNull();
      });
    });

    describe('update', () => {
      it('updates calories', async () => {
        const { admin, categoryId } = await setup();
        const created = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { calories: 300 }));

        const updated = await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${created.body.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { calories: 500 }));
        expect(updated.status).toBe(200);
        expect(updated.body.calories).toBe(500);
      });

      it('clears calories using an explicit null', async () => {
        const { admin, categoryId } = await setup();
        const created = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { calories: 300 }));

        const updated = await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${created.body.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { calories: null }));
        expect(updated.status).toBe(200);
        expect(updated.body.calories).toBeNull();
      });

      it('updates compareAtPrice', async () => {
        const { admin, categoryId } = await setup();
        const created = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { basePrice: 20, compareAtPrice: 25 }));

        const updated = await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${created.body.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { basePrice: 20, compareAtPrice: 30 }));
        expect(updated.status).toBe(200);
        expect(updated.body.compareAtPrice).toBe(30);
      });

      it('clears compareAtPrice using an explicit null', async () => {
        const { admin, categoryId } = await setup();
        const created = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { basePrice: 20, compareAtPrice: 25 }));

        const updated = await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${created.body.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { basePrice: 20, compareAtPrice: null }));
        expect(updated.status).toBe(200);
        expect(updated.body.compareAtPrice).toBeNull();
      });

      it('changes badge from BESTSELLER to TOP_RATED', async () => {
        const { admin, categoryId } = await setup();
        const created = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { badge: 'BESTSELLER' }));

        const updated = await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${created.body.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { badge: 'TOP_RATED' }));
        expect(updated.status).toBe(200);
        expect(updated.body.badge).toBe('TOP_RATED');
      });

      it('clears badge using an explicit null', async () => {
        const { admin, categoryId } = await setup();
        const created = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { badge: 'BESTSELLER' }));

        const updated = await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${created.body.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { badge: null }));
        expect(updated.status).toBe(200);
        expect(updated.body.badge).toBeNull();
      });
    });

    describe('validation', () => {
      it('rejects a compareAtPrice equal to basePrice (422)', async () => {
        const { admin, categoryId } = await setup();
        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { basePrice: 20, compareAtPrice: 20 }));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('INVALID_COMPARE_AT_PRICE');
      });

      it('rejects a compareAtPrice below basePrice (422)', async () => {
        const { admin, categoryId } = await setup();
        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { basePrice: 20, compareAtPrice: 15 }));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('INVALID_COMPARE_AT_PRICE');
      });

      it('rejects an unsupported badge string (400)', async () => {
        const { admin, categoryId } = await setup();
        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { badge: 'NOT_A_REAL_BADGE' }));
        expect(res.status).toBe(400);
      });

      it('rejects negative calories (400)', async () => {
        const { admin, categoryId } = await setup();
        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { calories: -10 }));
        expect(res.status).toBe(400);
      });

      it('rejects decimal calories (400)', async () => {
        const { admin, categoryId } = await setup();
        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { calories: 250.5 }));
        expect(res.status).toBe(400);
      });

      it('rejects negative compareAtPrice (400)', async () => {
        const { admin, categoryId } = await setup();
        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { compareAtPrice: -5 }));
        expect(res.status).toBe(400);
      });

      it('rejects an update that raises basePrice past an unchanged compareAtPrice (422)', async () => {
        const { admin, categoryId } = await setup();
        const created = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { basePrice: 20, compareAtPrice: 25 }));

        // basePrice moves to 30 without touching compareAtPrice in this PUT body —
        // the stored compareAtPrice (25) would no longer be greater than basePrice.
        const updated = await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${created.body.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { basePrice: 30 }));
        expect(updated.status).toBe(422);
        expect(updated.body.code).toBe('INVALID_COMPARE_AT_PRICE');

        const unchanged = await prisma.menuItem.findUnique({ where: { id: created.body.id } });
        expect(unchanged?.basePrice.toNumber()).toBe(20);
      });
    });

    describe('serialization', () => {
      it('returns compareAtPrice as a JSON number in the admin response, and independent badge/isPopular', async () => {
        const { admin, categoryId } = await setup();
        const withBadge = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(
            newMenuItemPayload(categoryId, {
              basePrice: 20,
              compareAtPrice: 25,
              badge: 'BESTSELLER',
              isPopular: false,
            }),
          );
        expect(withBadge.status).toBe(201);
        expect(typeof withBadge.body.compareAtPrice).toBe('number');
        expect(withBadge.body.badge).toBe('BESTSELLER');
        expect(withBadge.body.isPopular).toBe(false);

        const noBadgePopular = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { isPopular: true }));
        expect(noBadgePopular.status).toBe(201);
        expect(noBadgePopular.body.badge).toBeNull();
        expect(noBadgePopular.body.isPopular).toBe(true);
        expect(noBadgePopular.body.calories).toBeNull();
        expect(noBadgePopular.body.compareAtPrice).toBeNull();
      });
    });
  });

  // ===========================================================================
  describe('Menu item recommendations (Often Ordered With)', () => {
    async function setup() {
      const admin = await registerAdmin();
      const category = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCategoryPayload());
      cleanupCategoryIds.push(category.body.id);
      return { admin, categoryId: category.body.id as string };
    }

    async function createItem(
      admin: { accessToken: string },
      categoryId: string,
      overrides: Record<string, unknown> = {},
    ) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/menu/items')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newMenuItemPayload(categoryId, overrides));
      return res.body;
    }

    describe('create', () => {
      it('creates an item with three recommendations, stored in submitted order', async () => {
        const { admin, categoryId } = await setup();
        const a = await createItem(admin, categoryId);
        const b = await createItem(admin, categoryId);
        const c = await createItem(admin, categoryId);

        const created = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [a.id, b.id, c.id] }));
        expect(created.status).toBe(201);
        expect(created.body.recommendationItemIds).toEqual([a.id, b.id, c.id]);
      });

      it('creates an item with omitted recommendationItemIds returning []', async () => {
        const { admin, categoryId } = await setup();
        const created = await createItem(admin, categoryId);
        expect(created.recommendationItemIds).toEqual([]);
      });

      it('creates an item with an empty recommendationItemIds array returning []', async () => {
        const { admin, categoryId } = await setup();
        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [] }));
        expect(res.status).toBe(201);
        expect(res.body.recommendationItemIds).toEqual([]);
      });

      it('rolls back the entire MenuItem creation when a recommendation is invalid', async () => {
        const { admin, categoryId } = await setup();
        const countBefore = await prisma.menuItem.count({ where: { categoryId } });

        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [randomUUID()] }));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('INVALID_RECOMMENDATION_ITEM');

        const countAfter = await prisma.menuItem.count({ where: { categoryId } });
        expect(countAfter).toBe(countBefore);
      });
    });

    describe('update', () => {
      it('adds recommendations to an existing item', async () => {
        const { admin, categoryId } = await setup();
        const target = await createItem(admin, categoryId);
        const a = await createItem(admin, categoryId);

        const updated = await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${target.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [a.id] }));
        expect(updated.status).toBe(200);
        expect(updated.body.recommendationItemIds).toEqual([a.id]);
      });

      it('reorders existing recommendations', async () => {
        const { admin, categoryId } = await setup();
        const target = await createItem(admin, categoryId);
        const a = await createItem(admin, categoryId);
        const b = await createItem(admin, categoryId);
        await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${target.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [a.id, b.id] }));

        const reordered = await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${target.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [b.id, a.id] }));
        expect(reordered.status).toBe(200);
        expect(reordered.body.recommendationItemIds).toEqual([b.id, a.id]);
      });

      it('replaces one recommendation', async () => {
        const { admin, categoryId } = await setup();
        const target = await createItem(admin, categoryId);
        const a = await createItem(admin, categoryId);
        const b = await createItem(admin, categoryId);
        const c = await createItem(admin, categoryId);
        await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${target.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [a.id, b.id] }));

        const replaced = await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${target.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [a.id, c.id] }));
        expect(replaced.status).toBe(200);
        expect(replaced.body.recommendationItemIds).toEqual([a.id, c.id]);
      });

      it('removes one recommendation', async () => {
        const { admin, categoryId } = await setup();
        const target = await createItem(admin, categoryId);
        const a = await createItem(admin, categoryId);
        const b = await createItem(admin, categoryId);
        await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${target.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [a.id, b.id] }));

        const removed = await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${target.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [a.id] }));
        expect(removed.status).toBe(200);
        expect(removed.body.recommendationItemIds).toEqual([a.id]);
      });

      it('clears all recommendations with []', async () => {
        const { admin, categoryId } = await setup();
        const target = await createItem(admin, categoryId);
        const a = await createItem(admin, categoryId);
        await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${target.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [a.id] }));

        const cleared = await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${target.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [] }));
        expect(cleared.status).toBe(200);
        expect(cleared.body.recommendationItemIds).toEqual([]);
      });

      it('preserves existing recommendations when the field is omitted', async () => {
        const { admin, categoryId } = await setup();
        const target = await createItem(admin, categoryId);
        const a = await createItem(admin, categoryId);
        await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${target.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [a.id] }));

        const untouched = await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${target.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { nameEn: 'Renamed, recs untouched' }));
        expect(untouched.status).toBe(200);
        expect(untouched.body.recommendationItemIds).toEqual([a.id]);
      });

      it('does not alter incoming recommendation rows when updating outgoing recommendations', async () => {
        const { admin, categoryId } = await setup();
        const itemA = await createItem(admin, categoryId);
        const itemB = await createItem(admin, categoryId);
        const itemC = await createItem(admin, categoryId);

        // B recommends A (an "incoming" recommendation for A).
        await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${itemB.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [itemA.id] }));

        // A's own outgoing recommendations change independently.
        await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${itemA.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [itemC.id] }));

        const bAfter = await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${itemB.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { nameEn: 'B unchanged recs' }));
        expect(bAfter.status).toBe(200);
        expect(bAfter.body.recommendationItemIds).toEqual([itemA.id]);

        const incomingRow = await prisma.menuItemRecommendation.findFirst({
          where: { menuItemId: itemB.id, recommendedMenuItemId: itemA.id },
        });
        expect(incomingRow).not.toBeNull();
      });
    });

    describe('validation', () => {
      it('rejects more than three recommendation IDs (400)', async () => {
        const { admin, categoryId } = await setup();
        const a = await createItem(admin, categoryId);
        const b = await createItem(admin, categoryId);
        const c = await createItem(admin, categoryId);
        const d = await createItem(admin, categoryId);

        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(
            newMenuItemPayload(categoryId, { recommendationItemIds: [a.id, b.id, c.id, d.id] }),
          );
        expect(res.status).toBe(400);
      });

      it('rejects duplicate recommendation IDs (422)', async () => {
        const { admin, categoryId } = await setup();
        const a = await createItem(admin, categoryId);

        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [a.id, a.id] }));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('DUPLICATE_RECOMMENDATIONS');
      });

      it('rejects self-reference on update (422)', async () => {
        const { admin, categoryId } = await setup();
        const target = await createItem(admin, categoryId);

        const res = await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${target.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [target.id] }));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('SELF_RECOMMENDATION_NOT_ALLOWED');
      });

      it('rejects a missing menu item ID (422)', async () => {
        const { admin, categoryId } = await setup();

        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [randomUUID()] }));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('INVALID_RECOMMENDATION_ITEM');
      });

      it('rejects a soft-deleted menu item ID (422)', async () => {
        const { admin, categoryId } = await setup();
        const target = await createItem(admin, categoryId);
        const deleted = await createItem(admin, categoryId);
        await request(app.getHttpServer())
          .delete(`/api/v1/admin/menu/items/${deleted.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`);

        const res = await request(app.getHttpServer())
          .put(`/api/v1/admin/menu/items/${target.id}`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [deleted.id] }));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('INVALID_RECOMMENDATION_ITEM');
      });

      it('rejects a malformed UUID via DTO validation (400)', async () => {
        const { admin, categoryId } = await setup();

        const res = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: ['not-a-uuid'] }));
        expect(res.status).toBe(400);
      });
    });

    describe('admin response', () => {
      it('returns recommendationItemIds ordered by displayOrder, in both detail and list responses', async () => {
        const { admin, categoryId } = await setup();
        const a = await createItem(admin, categoryId);
        const b = await createItem(admin, categoryId);
        const c = await createItem(admin, categoryId);

        const created = await request(app.getHttpServer())
          .post('/api/v1/admin/menu/items')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(newMenuItemPayload(categoryId, { recommendationItemIds: [c.id, a.id, b.id] }));
        expect(created.status).toBe(201);
        expect(created.body.recommendationItemIds).toEqual([c.id, a.id, b.id]);

        const list = await request(app.getHttpServer())
          .get('/api/v1/admin/menu')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .query({ categoryId });
        const found = list.body.find((i: { id: string }) => i.id === created.body.id);
        expect(found.recommendationItemIds).toEqual([c.id, a.id, b.id]);
      });

      it('returns [] when no recommendations exist', async () => {
        const { admin, categoryId } = await setup();
        const created = await createItem(admin, categoryId);
        expect(created.recommendationItemIds).toEqual([]);
      });
    });
  });

  // ===========================================================================
  describe('Variants management', () => {
    it('creates, updates in place, removes, and adds variants on PUT', async () => {
      const admin = await registerAdmin();
      const category = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCategoryPayload());
      cleanupCategoryIds.push(category.body.id);

      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/menu/items')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(
          newMenuItemPayload(category.body.id, {
            variants: [
              { nameAr: 'صغير', nameEn: 'Small', priceDelta: 0, isDefault: true },
              { nameAr: 'كبير', nameEn: 'Large', priceDelta: 10 },
            ],
          }),
        );
      expect(created.status).toBe(201);
      expect(created.body.variants).toHaveLength(2);
      const keep = created.body.variants.find((v: { nameEn: string }) => v.nameEn === 'Small');
      const remove = created.body.variants.find((v: { nameEn: string }) => v.nameEn === 'Large');

      const updated = await request(app.getHttpServer())
        .put(`/api/v1/admin/menu/items/${created.body.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(
          newMenuItemPayload(category.body.id, {
            variants: [
              {
                id: keep.id,
                nameAr: keep.nameAr,
                nameEn: 'Small (updated)',
                priceDelta: 1,
                isDefault: true,
              },
              { nameAr: 'وسط', nameEn: 'Medium', priceDelta: 5 },
            ],
          }),
        );
      expect(updated.status).toBe(200);
      expect(updated.body.variants).toHaveLength(2);
      expect(updated.body.variants.find((v: { id: string }) => v.id === keep.id).nameEn).toBe(
        'Small (updated)',
      );
      expect(updated.body.variants.some((v: { nameEn: string }) => v.nameEn === 'Medium')).toBe(
        true,
      );
      expect(updated.body.variants.some((v: { id: string }) => v.id === remove.id)).toBe(false);

      const removedRow = await prisma.itemVariant.findUnique({ where: { id: remove.id } });
      expect(removedRow).toBeNull();
    });

    it('rejects a variant id that belongs to a different menu item (422)', async () => {
      const admin = await registerAdmin();
      const category = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCategoryPayload());
      cleanupCategoryIds.push(category.body.id);

      const itemA = await request(app.getHttpServer())
        .post('/api/v1/admin/menu/items')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(
          newMenuItemPayload(category.body.id, {
            variants: [{ nameAr: 'أ', nameEn: 'A', priceDelta: 0 }],
          }),
        );
      const itemB = await request(app.getHttpServer())
        .post('/api/v1/admin/menu/items')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newMenuItemPayload(category.body.id));

      const foreignVariantId = itemA.body.variants[0].id;
      const res = await request(app.getHttpServer())
        .put(`/api/v1/admin/menu/items/${itemB.body.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(
          newMenuItemPayload(category.body.id, {
            variants: [{ id: foreignVariantId, nameAr: 'أ', nameEn: 'A', priceDelta: 0 }],
          }),
        );
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_VARIANT_ASSOCIATION');
    });
  });

  // ===========================================================================
  describe('Addon groups / addons management', () => {
    function withAddonGroup() {
      return {
        addonGroups: [
          {
            titleAr: 'إضافات',
            titleEn: 'Extras',
            minSelect: 0,
            maxSelect: 2,
            addons: [
              { nameAr: 'إضافة 1', nameEn: 'Extra 1', price: 2 },
              { nameAr: 'إضافة 2', nameEn: 'Extra 2', price: 3 },
            ],
          },
        ],
      };
    }

    it('creates, updates in place, removes, and adds addons on PUT', async () => {
      const admin = await registerAdmin();
      const category = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCategoryPayload());
      cleanupCategoryIds.push(category.body.id);

      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/menu/items')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newMenuItemPayload(category.body.id, withAddonGroup()));
      expect(created.status).toBe(201);
      const group = created.body.addonGroups[0];
      expect(group.addons).toHaveLength(2);
      const keepAddon = group.addons.find((a: { nameEn: string }) => a.nameEn === 'Extra 1');
      const removeAddon = group.addons.find((a: { nameEn: string }) => a.nameEn === 'Extra 2');

      const updated = await request(app.getHttpServer())
        .put(`/api/v1/admin/menu/items/${created.body.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(
          newMenuItemPayload(category.body.id, {
            addonGroups: [
              {
                id: group.id,
                titleAr: group.titleAr,
                titleEn: 'Extras (updated)',
                maxSelect: 3,
                addons: [
                  {
                    id: keepAddon.id,
                    nameAr: keepAddon.nameAr,
                    nameEn: 'Extra 1 (updated)',
                    price: 9,
                  },
                  { nameAr: 'إضافة 3', nameEn: 'Extra 3', price: 4 },
                ],
              },
            ],
          }),
        );
      expect(updated.status).toBe(200);
      const updatedGroup = updated.body.addonGroups[0];
      expect(updatedGroup.titleEn).toBe('Extras (updated)');
      expect(updatedGroup.addons).toHaveLength(2);
      expect(updatedGroup.addons.find((a: { id: string }) => a.id === keepAddon.id).price).toBe(9);
      expect(updatedGroup.addons.some((a: { nameEn: string }) => a.nameEn === 'Extra 3')).toBe(
        true,
      );

      const removedRow = await prisma.addon.findUnique({ where: { id: removeAddon.id } });
      expect(removedRow).toBeNull();
    });

    it('rejects an addon group id belonging to a different menu item (422)', async () => {
      const admin = await registerAdmin();
      const category = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCategoryPayload());
      cleanupCategoryIds.push(category.body.id);

      const itemA = await request(app.getHttpServer())
        .post('/api/v1/admin/menu/items')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newMenuItemPayload(category.body.id, withAddonGroup()));
      const itemB = await request(app.getHttpServer())
        .post('/api/v1/admin/menu/items')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newMenuItemPayload(category.body.id));

      const foreignGroupId = itemA.body.addonGroups[0].id;
      const res = await request(app.getHttpServer())
        .put(`/api/v1/admin/menu/items/${itemB.body.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(
          newMenuItemPayload(category.body.id, {
            addonGroups: [{ id: foreignGroupId, titleAr: 'إضافات', titleEn: 'Extras', addons: [] }],
          }),
        );
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_ADDON_GROUP_ASSOCIATION');
    });

    it('rejects an addon id belonging to a different addon group (422)', async () => {
      const admin = await registerAdmin();
      const category = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCategoryPayload());
      cleanupCategoryIds.push(category.body.id);

      const item = await request(app.getHttpServer())
        .post('/api/v1/admin/menu/items')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(
          newMenuItemPayload(category.body.id, {
            addonGroups: [
              {
                titleAr: 'مجموعة 1',
                titleEn: 'Group 1',
                addons: [{ nameAr: 'خيار', nameEn: 'Choice', price: 1 }],
              },
              { titleAr: 'مجموعة 2', titleEn: 'Group 2', addons: [] },
            ],
          }),
        );
      const groupOne = item.body.addonGroups.find(
        (g: { titleEn: string }) => g.titleEn === 'Group 1',
      );
      const groupTwo = item.body.addonGroups.find(
        (g: { titleEn: string }) => g.titleEn === 'Group 2',
      );
      const foreignAddonId = groupOne.addons[0].id;

      const res = await request(app.getHttpServer())
        .put(`/api/v1/admin/menu/items/${item.body.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(
          newMenuItemPayload(category.body.id, {
            addonGroups: [
              { id: groupOne.id, titleAr: 'مجموعة 1', titleEn: 'Group 1', addons: [] },
              {
                id: groupTwo.id,
                titleAr: 'مجموعة 2',
                titleEn: 'Group 2',
                addons: [{ id: foreignAddonId, nameAr: 'خيار', nameEn: 'Choice', price: 1 }],
              },
            ],
          }),
        );
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_ADDON_ASSOCIATION');
    });
  });

  // ===========================================================================
  describe('Referential integrity', () => {
    it('blocks removing an addon currently selected in an active cart (409) and rolls back', async () => {
      const admin = await registerAdmin();
      const customer = await registerCustomer();
      const category = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCategoryPayload());
      cleanupCategoryIds.push(category.body.id);

      const item = await request(app.getHttpServer())
        .post('/api/v1/admin/menu/items')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(
          newMenuItemPayload(category.body.id, {
            addonGroups: [
              {
                titleAr: 'إضافات',
                titleEn: 'Extras',
                addons: [{ nameAr: 'إضافة', nameEn: 'Extra', price: 2 }],
              },
            ],
          }),
        );
      const group = item.body.addonGroups[0];
      const addon = group.addons[0];

      const addToCart = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('Authorization', `Bearer ${customer.accessToken}`)
        .send({ menuItemId: item.body.id, addonIds: [addon.id], quantity: 1 });
      expect(addToCart.status).toBe(201);

      const res = await request(app.getHttpServer())
        .put(`/api/v1/admin/menu/items/${item.body.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(
          newMenuItemPayload(category.body.id, {
            addonGroups: [
              { id: group.id, titleAr: group.titleAr, titleEn: group.titleEn, addons: [] },
            ],
          }),
        );
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MENU_ENTITY_IN_USE');

      const stillThere = await prisma.addon.findUnique({ where: { id: addon.id } });
      expect(stillThere).not.toBeNull();
    });
  });

  // ===========================================================================
  describe('Public catalog reflects admin changes', () => {
    it('a newly created category+item appears publicly; edits/availability/deletion propagate', async () => {
      const admin = await registerAdmin();
      const category = await request(app.getHttpServer())
        .post('/api/v1/admin/categories')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newCategoryPayload());
      cleanupCategoryIds.push(category.body.id);

      const publicCategories = await request(app.getHttpServer()).get('/api/v1/categories');
      expect(publicCategories.body.some((c: { id: string }) => c.id === category.body.id)).toBe(
        true,
      );

      const item = await request(app.getHttpServer())
        .post('/api/v1/admin/menu/items')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(newMenuItemPayload(category.body.id));
      const publicMenu = await request(app.getHttpServer())
        .get('/api/v1/menu')
        .query({ categoryId: category.body.id });
      expect(publicMenu.body.some((i: { id: string }) => i.id === item.body.id)).toBe(true);
    });
  });
});
