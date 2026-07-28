import { Prisma, PrismaClient, RestaurantSettings } from '@prisma/client';
import { seedRestaurantSettings } from '../prisma/seed';

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
