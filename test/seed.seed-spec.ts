import { Prisma, PrismaClient, RestaurantSettings } from '@prisma/client';
import {
  id,
  retireLegacyFakeCatalog,
  seedRestaurantSettings,
  seedVo3Categories,
  seedVo3MenuItems,
} from '../prisma/seed';
import { VO3_MENU } from '../prisma/data/vo3-menu.data';

/**
 * Regression coverage for the RestaurantSettings seed idempotency fix.
 *
 * Before this fix, `prisma/seed.ts` upserted the RestaurantSettings
 * singleton with the SAME operational fields (phone, address, currency, tax
 * rate, delivery fee, minimum order, working hours, timezone) in both the
 * `create` and `update` branches — so every seed run (e.g. on each deploy)
 * silently reverted any changes an admin made via PUT /admin/settings back
 * to the hardcoded defaults.
 *
 * `seedRestaurantSettings()` is now create-only: it writes the (Saudi
 * Arabia) defaults exactly once, when no row exists yet, and never touches
 * an existing row again. These tests run against the real dev PostgreSQL
 * instance (DATABASE_URL from .env, same as the other `test/*-spec.ts`
 * integration suites) and restore whatever row existed before the suite ran
 * so other suites sharing this database see the same baseline they started
 * with.
 */
describe('seedRestaurantSettings (seed idempotency)', () => {
  const prisma = new PrismaClient();
  let originalRow: RestaurantSettings | null = null;

  beforeAll(async () => {
    originalRow = await prisma.restaurantSettings.findFirst({ where: { singleton: true } });
  });

  beforeEach(async () => {
    // Every test in this suite manages its own row lifecycle starting from
    // "no row exists" so each test's precondition is real, not accidental
    // (the dev database normally already has a seeded singleton row).
    await prisma.restaurantSettings.deleteMany({});
  });

  afterAll(async () => {
    await prisma.restaurantSettings.deleteMany({});
    if (originalRow) {
      const { updatedAt: _updatedAt, workingHours, ...rest } = originalRow;
      await prisma.restaurantSettings.create({
        data: { ...rest, workingHours: workingHours as Prisma.InputJsonValue },
      });
    }
    await prisma.$disconnect();
  });

  it('creates Saudi Arabia defaults on the first run (no existing row)', async () => {
    await seedRestaurantSettings(prisma);

    const row = await prisma.restaurantSettings.findFirstOrThrow({ where: { singleton: true } });
    expect(row.phone).toBe('+966500000000');
    expect(row.addressEn).toBe('Jeddah, Saudi Arabia');
    expect(row.currency).toBe('SAR');
    expect(row.timezone).toBe('Asia/Riyadh');
    expect(row.taxRatePercent.toNumber()).toBe(14);
    expect(row.deliveryFee.toNumber()).toBe(20);
    expect(row.minOrderAmount.toNumber()).toBe(50);
  });

  it('does not modify an existing row on a second seed run', async () => {
    await seedRestaurantSettings(prisma);
    const firstRun = await prisma.restaurantSettings.findFirstOrThrow({
      where: { singleton: true },
    });

    await seedRestaurantSettings(prisma);
    const secondRun = await prisma.restaurantSettings.findFirstOrThrow({
      where: { singleton: true },
    });

    expect(secondRun).toEqual(firstRun);
  });

  it('preserves an admin-edited row across a reseed', async () => {
    await seedRestaurantSettings(prisma);
    const created = await prisma.restaurantSettings.findFirstOrThrow({
      where: { singleton: true },
    });

    const adminEdits = {
      phone: '+966512345678',
      addressAr: 'الرياض، المملكة العربية السعودية',
      addressEn: 'Riyadh, Saudi Arabia',
      currency: 'SAR',
      taxRatePercent: new Prisma.Decimal('15.00'),
      deliveryFee: new Prisma.Decimal('25.00'),
      minOrderAmount: new Prisma.Decimal('75.00'),
    };
    await prisma.restaurantSettings.update({ where: { id: created.id }, data: adminEdits });

    // Simulate a redeploy re-running the seed script.
    await seedRestaurantSettings(prisma);

    const afterReseed = await prisma.restaurantSettings.findFirstOrThrow({
      where: { singleton: true },
    });
    expect(afterReseed.phone).toBe(adminEdits.phone);
    expect(afterReseed.addressAr).toBe(adminEdits.addressAr);
    expect(afterReseed.addressEn).toBe(adminEdits.addressEn);
    expect(afterReseed.currency).toBe(adminEdits.currency);
    expect(afterReseed.taxRatePercent.toNumber()).toBe(15);
    expect(afterReseed.deliveryFee.toNumber()).toBe(25);
    expect(afterReseed.minOrderAmount.toNumber()).toBe(75);
  });
});

/**
 * Pure data-shape validation for the approved VO3 menu (prisma/data/vo3-menu.data.ts).
 * No database access — these only fail on a data-entry mistake in the dataset itself.
 */
describe('VO3 menu dataset (static validation)', () => {
  const BADGES = ['BESTSELLER', 'TOP_RATED'];
  const allItems = VO3_MENU.flatMap((category) => category.items);

  it('has exactly 8 approved categories with unique keys', () => {
    expect(VO3_MENU).toHaveLength(8);
    const keys = VO3_MENU.map((category) => category.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every menu item key is globally unique', () => {
    const keys = allItems.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not contain a duplicate "Kilo Mixed Grill" product', () => {
    const keys = allItems.map((item) => item.key);
    expect(keys.filter((key) => key === 'kilo-mixed-grill')).toHaveLength(1);
  });

  it('every item has bilingual name/description text and a non-negative basePrice', () => {
    for (const item of allItems) {
      expect(item.nameAr.length).toBeGreaterThan(0);
      expect(item.nameEn.length).toBeGreaterThan(0);
      expect(item.descriptionAr.length).toBeGreaterThan(0);
      expect(item.descriptionEn.length).toBeGreaterThan(0);
      expect(item.basePrice).toBeGreaterThanOrEqual(0);
    }
  });

  it('compareAtPrice, when set, is greater than basePrice', () => {
    for (const item of allItems) {
      if (item.compareAtPrice !== undefined) {
        expect(item.compareAtPrice).toBeGreaterThan(item.basePrice);
      }
    }
  });

  it('calories, when set, is a non-negative integer', () => {
    for (const item of allItems) {
      if (item.calories !== undefined) {
        expect(Number.isInteger(item.calories)).toBe(true);
        expect(item.calories).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('badge, when set, is BESTSELLER or TOP_RATED', () => {
    for (const item of allItems) {
      if (item.badge !== undefined) {
        expect(BADGES).toContain(item.badge);
      }
    }
  });

  it('variant keys are unique within each item, and exactly one default variant exists when variants are present', () => {
    for (const item of allItems) {
      if (!item.variants || item.variants.length === 0) {
        continue;
      }
      const variantKeys = item.variants.map((variant) => variant.key);
      expect(new Set(variantKeys).size).toBe(variantKeys.length);
      expect(item.variants.filter((variant) => variant.isDefault)).toHaveLength(1);
    }
  });

  it('defines no "Often Ordered With" recommendation data (out of scope for this phase)', () => {
    for (const item of allItems) {
      expect(item).not.toHaveProperty('recommendationItemIds');
    }
  });
});

/**
 * Integration coverage for the two properties a pure data check can't see:
 * that seeding retires the legacy fake catalog without touching the real
 * rows, and that running the seed steps twice is fully idempotent. Runs
 * against the real dev PostgreSQL instance, same as the suite above — the
 * rows this creates ARE the intended permanent VO3 catalog, so (unlike other
 * integration suites) nothing here is cleaned up afterwards.
 */
describe('VO3 menu seeding (integration)', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('seeds all 8 categories as active, in the approved order', async () => {
    const categoryIds = await seedVo3Categories();
    expect(categoryIds.size).toBe(8);

    const rows = await prisma.category.findMany({
      where: { id: { in: [...categoryIds.values()] } },
      orderBy: { displayOrder: 'asc' },
    });
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.isActive && row.deletedAt === null)).toBe(true);
    expect(rows.map((row) => row.displayOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('retires the legacy fake catalog without touching the real one, and is idempotent across two runs', async () => {
    const categoryIds = await seedVo3Categories();
    const menuItemIds = await seedVo3MenuItems(categoryIds);
    await retireLegacyFakeCatalog(new Set(categoryIds.values()), menuItemIds);

    // "kebda" is used (not "kabsah") because this suite runs against the
    // shared dev database, which may carry pre-existing, unrelated manually
    // created menu items under the legacy "kabsah" category — retirement
    // correctly refuses to retire a category while ANY menu item (fake or
    // not) under it is still active, so "kabsah" is not a reliable fixture
    // here even though this code path is exercised regardless of which
    // legacy category ends up retired.
    const fakeCategoryId = id('category:kebda');
    const fakeItemId = id('menu-item:kebda-sandwich');
    const fakeCategoryRow = await prisma.category.findUnique({ where: { id: fakeCategoryId } });
    const fakeItemRow = await prisma.menuItem.findUnique({ where: { id: fakeItemId } });
    expect(fakeCategoryRow?.deletedAt).not.toBeNull();
    expect(fakeCategoryRow?.isActive).toBe(false);
    expect(fakeItemRow?.deletedAt).not.toBeNull();
    expect(fakeItemRow?.isAvailable).toBe(false);

    const publicItems = await prisma.menuItem.findMany({
      where: { deletedAt: null, isAvailable: true, category: { isActive: true, deletedAt: null } },
    });
    expect(publicItems.some((item) => item.id === fakeItemId)).toBe(false);

    const realCategoryCountBefore = await prisma.category.count({
      where: { id: { in: [...categoryIds.values()] }, deletedAt: null },
    });
    const realItemCountBefore = await prisma.menuItem.count({
      where: { id: { in: [...menuItemIds] }, deletedAt: null },
    });
    const totalCategoryRowsBefore = await prisma.category.count({
      where: { id: { in: [...categoryIds.values()] } },
    });
    const totalItemRowsBefore = await prisma.menuItem.count({
      where: { id: { in: [...menuItemIds] } },
    });

    // Second run: must not duplicate rows, reactivate fakes, or touch real rows.
    const categoryIds2 = await seedVo3Categories();
    const menuItemIds2 = await seedVo3MenuItems(categoryIds2);
    await retireLegacyFakeCatalog(new Set(categoryIds2.values()), menuItemIds2);

    expect(categoryIds2.size).toBe(categoryIds.size);
    expect(menuItemIds2.size).toBe(menuItemIds.size);

    const totalCategoryRowsAfter = await prisma.category.count({
      where: { id: { in: [...categoryIds.values()] } },
    });
    const totalItemRowsAfter = await prisma.menuItem.count({
      where: { id: { in: [...menuItemIds] } },
    });
    expect(totalCategoryRowsAfter).toBe(totalCategoryRowsBefore);
    expect(totalItemRowsAfter).toBe(totalItemRowsBefore);

    const realCategoryCountAfter = await prisma.category.count({
      where: { id: { in: [...categoryIds.values()] }, deletedAt: null },
    });
    const realItemCountAfter = await prisma.menuItem.count({
      where: { id: { in: [...menuItemIds] }, deletedAt: null },
    });
    expect(realCategoryCountAfter).toBe(realCategoryCountBefore);
    expect(realItemCountAfter).toBe(realItemCountBefore);

    const fakeCategoryRowAfter = await prisma.category.findUnique({
      where: { id: fakeCategoryId },
    });
    const fakeItemRowAfter = await prisma.menuItem.findUnique({ where: { id: fakeItemId } });
    expect(fakeCategoryRowAfter?.deletedAt).toEqual(fakeCategoryRow?.deletedAt);
    expect(fakeItemRowAfter?.deletedAt).toEqual(fakeItemRow?.deletedAt);
  });
});
