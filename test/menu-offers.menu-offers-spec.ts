import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { AuthService } from '../src/modules/auth/auth.service';

/** Smallest possible valid 1x1 transparent PNG — used to exercise the real
 * upload endpoint rather than faking an imageUrl string. */
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('Menu Offers (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;

  const cleanupUserIds: string[] = [];
  const cleanupCategoryIds: string[] = [];
  const cleanupOfferIds: string[] = [];

  async function registerCustomer() {
    const registered = await authService.register(
      {
        name: 'MO Customer',
        email: `mo-customer-${randomUUID()}@menu-offers.local`,
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
        name: 'MO Admin',
        email: `mo-admin-${randomUUID()}@menu-offers.local`,
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

  async function createCategoryAndItem(adminToken: string) {
    const category = await request(app.getHttpServer())
      .post('/api/v1/admin/categories')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ nameAr: `فئة ${randomUUID()}`, nameEn: `Category ${randomUUID()}`, displayOrder: 1 });
    cleanupCategoryIds.push(category.body.id);

    const item = await request(app.getHttpServer())
      .post('/api/v1/admin/menu/items')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        categoryId: category.body.id,
        nameAr: `صنف ${randomUUID()}`,
        nameEn: `Item ${randomUUID()}`,
        descriptionAr: 'وصف',
        descriptionEn: 'description',
        basePrice: 25.5,
      });
    return { categoryId: category.body.id, menuItemId: item.body.id as string };
  }

  async function uploadImage(adminToken: string) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/uploads/image')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', VALID_PNG, 'offer.png');
    return res;
  }

  function offerPayload(
    menuItemId: string,
    imageUrl: string,
    overrides: Record<string, unknown> = {},
  ) {
    return { menuItemId, imageUrl, ...overrides };
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
    if (cleanupOfferIds.length > 0) {
      await prisma.menuOffer.deleteMany({ where: { id: { in: cleanupOfferIds } } });
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
  describe('Access control', () => {
    it('rejects a CUSTOMER on admin menu-offer routes (403)', async () => {
      const customer = await registerCustomer();
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${customer.accessToken}`);
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated caller (401)', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/admin/menu-offers');
      expect(res.status).toBe(401);
    });

    it('allows an ADMIN', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(200);
    });
  });

  // ===========================================================================
  describe('Image upload (existing shared endpoint, reused as-is)', () => {
    it('uploads a valid PNG and returns an imageUrl', async () => {
      const admin = await registerAdmin();
      const res = await uploadImage(admin.accessToken);
      expect(res.status).toBe(201);
      expect(typeof res.body.imageUrl).toBe('string');
      expect(res.body.imageUrl).toContain('/uploads/');
    });

    it('rejects an unsupported file type (400)', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/uploads/image')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .attach('file', Buffer.from('not an image'), 'offer.txt');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_FILE_TYPE');
    });

    it('rejects an oversized file (400/413)', async () => {
      const admin = await registerAdmin();
      const oversized = Buffer.alloc(6 * 1024 * 1024, 1);
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/uploads/image')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .attach('file', oversized, 'offer.png');
      expect([400, 413]).toContain(res.status);
    });
  });

  // ===========================================================================
  describe('Admin CRUD', () => {
    it('creates an offer with an uploaded image, linked to a valid menu item', async () => {
      const admin = await registerAdmin();
      const { menuItemId } = await createCategoryAndItem(admin.accessToken);
      const upload = await uploadImage(admin.accessToken);

      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(offerPayload(menuItemId, upload.body.imageUrl, { title: 'Ramadan Special' }));
      expect(created.status).toBe(201);
      expect(created.body.menuItemId).toBe(menuItemId);
      expect(created.body.imageUrl).toBe(upload.body.imageUrl);
      expect(created.body.isActive).toBe(true);
      expect(created.body.menuItem.id).toBe(menuItemId);
      cleanupOfferIds.push(created.body.id);
    });

    it('creating a second offer does not overwrite the first', async () => {
      const admin = await registerAdmin();
      const { menuItemId } = await createCategoryAndItem(admin.accessToken);
      const upload = await uploadImage(admin.accessToken);

      const first = await request(app.getHttpServer())
        .post('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(offerPayload(menuItemId, upload.body.imageUrl));
      cleanupOfferIds.push(first.body.id);

      const second = await request(app.getHttpServer())
        .post('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(offerPayload(menuItemId, upload.body.imageUrl));
      cleanupOfferIds.push(second.body.id);

      expect(second.body.id).not.toBe(first.body.id);

      const stillThere = await prisma.menuOffer.findUnique({ where: { id: first.body.id } });
      expect(stillThere).not.toBeNull();
    });

    it('rejects an offer linked to a non-existent menu item (422)', async () => {
      const admin = await registerAdmin();
      const upload = await uploadImage(admin.accessToken);
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(offerPayload(randomUUID(), upload.body.imageUrl));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_MENU_ITEM');
    });

    it('rejects endAt preceding startAt (422)', async () => {
      const admin = await registerAdmin();
      const { menuItemId } = await createCategoryAndItem(admin.accessToken);
      const upload = await uploadImage(admin.accessToken);
      const res = await request(app.getHttpServer())
        .post('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(
          offerPayload(menuItemId, upload.body.imageUrl, {
            startAt: '2026-08-10T00:00:00.000Z',
            endAt: '2026-08-01T00:00:00.000Z',
          }),
        );
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('MENU_OFFER_INVALID_DATE_RANGE');
    });

    it('lists offers for admin', async () => {
      const admin = await registerAdmin();
      const { menuItemId } = await createCategoryAndItem(admin.accessToken);
      const upload = await uploadImage(admin.accessToken);
      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(offerPayload(menuItemId, upload.body.imageUrl));
      cleanupOfferIds.push(created.body.id);

      const list = await request(app.getHttpServer())
        .get('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(list.status).toBe(200);
      expect(list.body.some((o: { id: string }) => o.id === created.body.id)).toBe(true);
    });

    it('updates the image, linked item, activation, and sortOrder', async () => {
      const admin = await registerAdmin();
      const { menuItemId } = await createCategoryAndItem(admin.accessToken);
      const { menuItemId: otherMenuItemId } = await createCategoryAndItem(admin.accessToken);
      const upload1 = await uploadImage(admin.accessToken);
      const upload2 = await uploadImage(admin.accessToken);

      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(offerPayload(menuItemId, upload1.body.imageUrl, { sortOrder: 1 }));
      cleanupOfferIds.push(created.body.id);

      const updated = await request(app.getHttpServer())
        .put(`/api/v1/admin/menu-offers/${created.body.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(
          offerPayload(otherMenuItemId, upload2.body.imageUrl, { isActive: false, sortOrder: 5 }),
        );
      expect(updated.status).toBe(200);
      expect(updated.body.imageUrl).toBe(upload2.body.imageUrl);
      expect(updated.body.menuItemId).toBe(otherMenuItemId);
      expect(updated.body.isActive).toBe(false);
      expect(updated.body.sortOrder).toBe(5);
    });

    it('deletes an offer without affecting the linked menu item', async () => {
      const admin = await registerAdmin();
      const { menuItemId } = await createCategoryAndItem(admin.accessToken);
      const upload = await uploadImage(admin.accessToken);
      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(offerPayload(menuItemId, upload.body.imageUrl));

      const removed = await request(app.getHttpServer())
        .delete(`/api/v1/admin/menu-offers/${created.body.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(removed.status).toBe(204);

      const offerRow = await prisma.menuOffer.findUnique({ where: { id: created.body.id } });
      expect(offerRow).toBeNull();

      const itemRow = await prisma.menuItem.findUnique({ where: { id: menuItemId } });
      expect(itemRow).not.toBeNull();
      expect(itemRow?.deletedAt).toBeNull();
    });
  });

  // ===========================================================================
  describe('Customer visibility (GET /menu-offers)', () => {
    it('returns an active, unscheduled offer, sorted by sortOrder', async () => {
      const admin = await registerAdmin();
      const { menuItemId: itemA } = await createCategoryAndItem(admin.accessToken);
      const { menuItemId: itemB } = await createCategoryAndItem(admin.accessToken);
      const upload = await uploadImage(admin.accessToken);

      const second = await request(app.getHttpServer())
        .post('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(offerPayload(itemB, upload.body.imageUrl, { sortOrder: 10 }));
      cleanupOfferIds.push(second.body.id);
      const first = await request(app.getHttpServer())
        .post('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(offerPayload(itemA, upload.body.imageUrl, { sortOrder: 1 }));
      cleanupOfferIds.push(first.body.id);

      const publicList = await request(app.getHttpServer()).get('/api/v1/menu-offers');
      expect(publicList.status).toBe(200);
      const ids = publicList.body.map((o: { id: string }) => o.id);
      expect(ids.indexOf(first.body.id)).toBeLessThan(ids.indexOf(second.body.id));
      expect(publicList.body.find((o: { id: string }) => o.id === first.body.id).menuItem.id).toBe(
        itemA,
      );
    });

    it('hides an inactive offer', async () => {
      const admin = await registerAdmin();
      const { menuItemId } = await createCategoryAndItem(admin.accessToken);
      const upload = await uploadImage(admin.accessToken);
      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(offerPayload(menuItemId, upload.body.imageUrl, { isActive: false }));
      cleanupOfferIds.push(created.body.id);

      const publicList = await request(app.getHttpServer()).get('/api/v1/menu-offers');
      expect(publicList.body.some((o: { id: string }) => o.id === created.body.id)).toBe(false);
    });

    it('hides an offer scheduled to start in the future', async () => {
      const admin = await registerAdmin();
      const { menuItemId } = await createCategoryAndItem(admin.accessToken);
      const upload = await uploadImage(admin.accessToken);
      const futureStart = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(offerPayload(menuItemId, upload.body.imageUrl, { startAt: futureStart }));
      cleanupOfferIds.push(created.body.id);

      const publicList = await request(app.getHttpServer()).get('/api/v1/menu-offers');
      expect(publicList.body.some((o: { id: string }) => o.id === created.body.id)).toBe(false);
    });

    it('hides an offer whose end date has passed', async () => {
      const admin = await registerAdmin();
      const { menuItemId } = await createCategoryAndItem(admin.accessToken);
      const upload = await uploadImage(admin.accessToken);
      const pastEnd = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(offerPayload(menuItemId, upload.body.imageUrl, { endAt: pastEnd }));
      cleanupOfferIds.push(created.body.id);

      const publicList = await request(app.getHttpServer()).get('/api/v1/menu-offers');
      expect(publicList.body.some((o: { id: string }) => o.id === created.body.id)).toBe(false);
    });

    it('shows an offer whose window is currently active', async () => {
      const admin = await registerAdmin();
      const { menuItemId } = await createCategoryAndItem(admin.accessToken);
      const upload = await uploadImage(admin.accessToken);
      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(
          offerPayload(menuItemId, upload.body.imageUrl, {
            startAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
            endAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          }),
        );
      cleanupOfferIds.push(created.body.id);

      const publicList = await request(app.getHttpServer()).get('/api/v1/menu-offers');
      expect(publicList.body.some((o: { id: string }) => o.id === created.body.id)).toBe(true);
    });

    it('still shows an offer whose linked item is temporarily out of stock (isAvailable=false)', async () => {
      const admin = await registerAdmin();
      const { menuItemId } = await createCategoryAndItem(admin.accessToken);
      const upload = await uploadImage(admin.accessToken);
      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(offerPayload(menuItemId, upload.body.imageUrl));
      cleanupOfferIds.push(created.body.id);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/menu/items/${menuItemId}/availability`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ isAvailable: false });

      const publicList = await request(app.getHttpServer()).get('/api/v1/menu-offers');
      expect(publicList.body.some((o: { id: string }) => o.id === created.body.id)).toBe(true);
    });

    it('hides an offer whose linked item was soft-deleted', async () => {
      const admin = await registerAdmin();
      const { menuItemId } = await createCategoryAndItem(admin.accessToken);
      const upload = await uploadImage(admin.accessToken);
      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/menu-offers')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(offerPayload(menuItemId, upload.body.imageUrl));
      cleanupOfferIds.push(created.body.id);

      await request(app.getHttpServer())
        .delete(`/api/v1/admin/menu/items/${menuItemId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);

      const publicList = await request(app.getHttpServer()).get('/api/v1/menu-offers');
      expect(publicList.body.some((o: { id: string }) => o.id === created.body.id)).toBe(false);

      // Deleting the offer itself must never delete the (already soft-deleted) menu item row.
      const itemRow = await prisma.menuItem.findUnique({ where: { id: menuItemId } });
      expect(itemRow).not.toBeNull();
    });
  });
});
