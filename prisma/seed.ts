import { createHash } from 'node:crypto';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaClient } from '@prisma/client';
import { VO3_MENU, type Vo3VariantSeed } from './data/vo3-menu.data';

/**
 * Kebda Zaman seed.
 *
 * Idempotent: every row is upserted against a deterministic UUID derived from a
 * stable human-readable key, so re-running this script never creates duplicates
 * and safely refreshes values on each run — EXCEPT the RestaurantSettings
 * singleton, which is create-only (see seedRestaurantSettings()) so that
 * operational config an admin has edited via the admin API is never
 * clobbered back to defaults by a redeploy.
 *
 * Seeds the RestaurantSettings singleton, the seeded admin account, and the
 * real approved VO3 menu (categories + menu items + variants, from
 * prisma/data/vo3-menu.data.ts). The original Phase-1 development fake
 * catalog is no longer seeded — retireLegacyFakeCatalog() soft-retires
 * whatever fake rows an earlier seed run already created.
 *
 * No plaintext passwords or production secrets are seeded: the admin account
 * is created with passwordHash = null. Credential provisioning is a Phase 2
 * (Authentication) concern — a real operator sets their own password through
 * the normal auth flow, never through this script. A previous revision of
 * this file seeded a second, login-capable admin with a hardcoded
 * email/plaintext password (seedRealAdmin()) — that was a credential leak
 * risk, not an intended provisioning step, and has been removed. Never
 * reintroduce a login-capable account here.
 */

export const prisma = new PrismaClient();

/** Deterministic, collision-free UUID derived from a stable seed key. */
export function id(seedKey: string): string {
  const hash = createHash('sha256').update(seedKey).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

function money(value: number): Decimal {
  return new Decimal(value.toFixed(2));
}

/**
 * Phase-1 development fake catalog — no longer seeded (replaced below by the
 * real VO3 menu). Kept only as the deterministic-key list needed to retire
 * the old rows still sitting in already-seeded databases; see
 * retireLegacyFakeCatalog(). Never reseed these — only retire them.
 */
const LEGACY_FAKE_CATEGORY_KEYS = [
  'kabsah',
  'kebda',
  'alexandrian',
  'extras',
  'drinks',
  'desserts',
] as const;

const LEGACY_FAKE_MENU_ITEM_KEYS = [
  'kebda-sandwich',
  'kebda-plate',
  'chicken-kabsah',
  'meat-kabsah',
  'alex-sausage',
  'alex-fatta',
  'fries',
  'tahini-salad',
  'soft-drink',
  'om-ali',
] as const;

const SEED_WEEKLY_HOURS = Array.from({ length: 7 }, (_, dayOfWeek) => ({
  dayOfWeek,
  isOpen: true,
  openTime: '10:00',
  closeTime: '02:00',
}));

/**
 * First-time defaults for the RestaurantSettings singleton. These are
 * intentionally generic Saudi Arabia placeholder values (a round,
 * clearly-not-real phone number and the city of Jeddah) — not a real
 * address or phone number — since an admin is expected to replace them via
 * the admin settings API once the restaurant is live. See
 * seedRestaurantSettings() for why these are only ever written once.
 */
export const RESTAURANT_SETTINGS_DEFAULTS = {
  restaurantNameAr: 'كبدة زمان',
  restaurantNameEn: 'Kebda Zaman',
  logoUrl: null,
  phone: '+966500000000',
  addressAr: 'جدة، المملكة العربية السعودية',
  addressEn: 'Jeddah, Saudi Arabia',
  taxRatePercent: money(14),
  deliveryFee: money(20),
  minOrderAmount: money(50),
  currency: 'SAR',
  workingHours: SEED_WEEKLY_HOURS,
  timezone: 'Asia/Riyadh',
  isMaintenanceMode: false,
  acceptingOrders: true,
  closedMessageAr: null,
  closedMessageEn: null,
  // Approved production restaurant location (VO3 distance-based delivery
  // pricing) — a real coordinate, not a placeholder, unlike the fields above.
  restaurantLatitude: 21.5705641,
  restaurantLongitude: 39.1681808,
};

/**
 * Creates the RestaurantSettings singleton the first time the seed runs, and
 * does nothing on every subsequent run.
 *
 * This is deliberately NOT an upsert: an upsert's `update` block would
 * rewrite every admin-editable operational field (phone, address, currency,
 * tax rate, delivery fee, minimum order, working hours, ...) back to the
 * hardcoded defaults on every deploy, silently discarding whatever an admin
 * configured via PUT /admin/settings. Once a row exists, this function
 * leaves it completely untouched.
 */
export async function seedRestaurantSettings(client: PrismaClient = prisma): Promise<void> {
  const existing = await client.restaurantSettings.findFirst({ where: { singleton: true } });
  if (existing) {
    return;
  }
  await client.restaurantSettings.create({
    data: {
      id: id('restaurant-settings:singleton'),
      singleton: true,
      ...RESTAURANT_SETTINGS_DEFAULTS,
    },
  });
}

async function seedAdmin(): Promise<void> {
  const adminId = id('user:admin');
  await prisma.user.upsert({
    where: { id: adminId },
    update: {
      fullName: 'Kebda Zaman Admin',
      role: 'ADMIN',
    },
    create: {
      id: adminId,
      email: 'admin@kebdazaman.local',
      // No password is seeded (Phase 2 / Authentication provisions real
      // credentials). Never store plaintext or placeholder secrets here.
      passwordHash: null,
      fullName: 'Kebda Zaman Admin',
      role: 'ADMIN',
      isGuest: false,
      locale: 'en',
      onboardingCompleted: true,
    },
  });
}

/**
 * Seeds the 8 approved VO3 categories. Category order in VO3_MENU IS the
 * approved display order — displayOrder is the array index, not hand-typed,
 * so reordering the data file is the only way to change it.
 */
export async function seedVo3Categories(): Promise<Map<string, string>> {
  const categoryIds = new Map<string, string>();

  for (const [index, category] of VO3_MENU.entries()) {
    const categoryId = id(`category:${category.key}`);
    categoryIds.set(category.key, categoryId);

    await prisma.category.upsert({
      where: { id: categoryId },
      update: {
        nameAr: category.nameAr,
        nameEn: category.nameEn,
        iconUrl: null,
        displayOrder: index,
        isActive: true,
        deletedAt: null,
      },
      create: {
        id: categoryId,
        nameAr: category.nameAr,
        nameEn: category.nameEn,
        iconUrl: null,
        displayOrder: index,
        isActive: true,
      },
    });
  }

  return categoryIds;
}

/**
 * Seeds every approved VO3 menu item (metadata set explicitly every run, so
 * a previous seed run can never leave a stale calories/compareAtPrice/badge
 * value behind) and its variants. Returns the full set of real menu item ids
 * so retireLegacyFakeCatalog() never retires a real row.
 */
export async function seedVo3MenuItems(categoryIds: Map<string, string>): Promise<Set<string>> {
  const menuItemIds = new Set<string>();

  for (const category of VO3_MENU) {
    const categoryId = categoryIds.get(category.key);
    if (!categoryId) {
      throw new Error(`Unknown VO3 category key "${category.key}"`);
    }

    for (const [itemIndex, item] of category.items.entries()) {
      const menuItemId = id(`menu-item:${item.key}`);
      menuItemIds.add(menuItemId);

      const data = {
        categoryId,
        nameAr: item.nameAr,
        nameEn: item.nameEn,
        descriptionAr: item.descriptionAr,
        descriptionEn: item.descriptionEn,
        basePrice: money(item.basePrice),
        compareAtPrice: item.compareAtPrice !== undefined ? money(item.compareAtPrice) : null,
        calories: item.calories ?? null,
        badge: item.badge ?? null,
        imageUrl: null,
        isAvailable: true,
        isPopular: false,
        displayOrder: itemIndex,
        deletedAt: null,
      };

      await prisma.menuItem.upsert({
        where: { id: menuItemId },
        update: data,
        create: { id: menuItemId, ...data },
      });

      await syncVo3Variants(menuItemId, item.key, item.variants ?? []);
    }
  }

  return menuItemIds;
}

/**
 * Idempotently syncs one item's variants to exactly the approved set, in the
 * approved order (displayOrder = array index). A variant no longer in the
 * dataset is deactivated, never deleted — a CartItem may still reference it.
 */
async function syncVo3Variants(
  menuItemId: string,
  itemKey: string,
  variants: Vo3VariantSeed[],
): Promise<void> {
  const keptIds: string[] = [];

  for (const [index, variant] of variants.entries()) {
    const variantId = id(`variant:${itemKey}:${variant.key}`);
    keptIds.push(variantId);

    const data = {
      menuItemId,
      nameAr: variant.nameAr,
      nameEn: variant.nameEn,
      priceDelta: money(variant.priceDelta),
      isDefault: variant.isDefault,
      isActive: true,
      displayOrder: index,
    };
    await prisma.itemVariant.upsert({
      where: { id: variantId },
      update: data,
      create: { id: variantId, ...data },
    });
  }

  await prisma.itemVariant.updateMany({
    where: { menuItemId, id: { notIn: keptIds } },
    data: { isActive: false },
  });
}

/**
 * Soft-retires the Phase-1 fake catalog now superseded by the real VO3 menu:
 * old fake MenuItems get deletedAt + isAvailable: false, then old fake
 * Categories get deletedAt + isActive: false (only once none of their
 * MenuItems are still active). Never a hard delete — CartItem/OrderItem hold
 * live/snapshot references respectively. The `deletedAt: null` guard on every
 * where-clause makes this idempotent: a second run matches zero rows and
 * never reactivates anything. `realCategoryIds`/`realMenuItemIds` guard
 * against ever retiring a real row, in case a legacy key were ever reused.
 */
export async function retireLegacyFakeCatalog(
  realCategoryIds: Set<string>,
  realMenuItemIds: Set<string>,
): Promise<void> {
  const now = new Date();

  const fakeMenuItemIds = LEGACY_FAKE_MENU_ITEM_KEYS.map((key) => id(`menu-item:${key}`)).filter(
    (menuItemId) => !realMenuItemIds.has(menuItemId),
  );
  if (fakeMenuItemIds.length > 0) {
    await prisma.menuItem.updateMany({
      where: { id: { in: fakeMenuItemIds }, deletedAt: null },
      data: { deletedAt: now, isAvailable: false },
    });
  }

  const fakeCategoryIds = LEGACY_FAKE_CATEGORY_KEYS.map((key) => id(`category:${key}`)).filter(
    (categoryId) => !realCategoryIds.has(categoryId),
  );
  if (fakeCategoryIds.length > 0) {
    const stillActiveItems = await prisma.menuItem.findMany({
      where: { categoryId: { in: fakeCategoryIds }, deletedAt: null },
      select: { categoryId: true },
    });
    const blockedCategoryIds = new Set(stillActiveItems.map((item) => item.categoryId));
    const categoryIdsToRetire = fakeCategoryIds.filter((catId) => !blockedCategoryIds.has(catId));

    if (categoryIdsToRetire.length > 0) {
      await prisma.category.updateMany({
        where: { id: { in: categoryIdsToRetire }, deletedAt: null },
        data: { deletedAt: now, isActive: false },
      });
    }
  }
}

const MAX_RECOMMENDATIONS_PER_ITEM = 3;

/**
 * Validates the static "Often Ordered With" dataset (recommendationKeys on
 * each VO3_MENU item) before any database write. Pure/no DB access — fails
 * fast with a descriptive error on the first violation found, per source
 * item, in dataset order.
 */
export function validateVo3Recommendations(): void {
  const allItems = VO3_MENU.flatMap((category) => category.items);
  const validKeys = new Set(allItems.map((item) => item.key));

  for (const item of allItems) {
    const targets = item.recommendationKeys ?? [];

    if (targets.length > MAX_RECOMMENDATIONS_PER_ITEM) {
      throw new Error(
        `VO3 recommendations: "${item.key}" has ${targets.length} targets, max ${MAX_RECOMMENDATIONS_PER_ITEM}`,
      );
    }
    if (new Set(targets).size !== targets.length) {
      throw new Error(`VO3 recommendations: "${item.key}" has a duplicate target key`);
    }
    if (targets.includes(item.key)) {
      throw new Error(`VO3 recommendations: "${item.key}" recommends itself`);
    }
    for (const targetKey of targets) {
      if (!validKeys.has(targetKey)) {
        throw new Error(
          `VO3 recommendations: "${item.key}" targets unknown/unapproved menu item key "${targetKey}"`,
        );
      }
    }
  }
}

/**
 * Fully synchronizes one VO3 source item's outgoing recommendation rows to
 * exactly `targetIds`, in that order — deletes rows for removed targets,
 * updates displayOrder for retained targets, creates rows for new targets.
 * Deletions happen before creates, so a retained/reordered target's row is
 * never touched by the unique (menuItemId, recommendedMenuItemId)
 * constraint. Scoped strictly to `menuItemId`'s own outgoing rows — never
 * touches incoming recommendations or any other item's rows.
 */
async function syncMenuItemRecommendations(
  menuItemId: string,
  targetIds: readonly string[],
): Promise<void> {
  const existing = await prisma.menuItemRecommendation.findMany({
    where: { menuItemId },
    select: { id: true, recommendedMenuItemId: true },
  });
  const existingByTarget = new Map(existing.map((r) => [r.recommendedMenuItemId, r.id]));
  const submittedTargets = new Set(targetIds);

  const idsToDelete = existing
    .filter((r) => !submittedTargets.has(r.recommendedMenuItemId))
    .map((r) => r.id);
  if (idsToDelete.length > 0) {
    await prisma.menuItemRecommendation.deleteMany({ where: { id: { in: idsToDelete } } });
  }

  for (const [index, recommendedMenuItemId] of targetIds.entries()) {
    const existingId = existingByTarget.get(recommendedMenuItemId);
    if (existingId) {
      await prisma.menuItemRecommendation.update({
        where: { id: existingId },
        data: { displayOrder: index },
      });
    } else {
      await prisma.menuItemRecommendation.create({
        data: { menuItemId, recommendedMenuItemId, displayOrder: index },
      });
    }
  }
}

/**
 * Seeds the approved "Often Ordered With" recommendations for every VO3 menu
 * item. Scoped strictly to the 65 approved VO3 item ids (both as source and
 * as resolved targets) — never touches recommendations belonging to any
 * non-VO3/manually created menu item. An item with no recommendationKeys (or
 * an explicit empty list) ends up with zero outgoing rows.
 */
export async function seedMenuItemRecommendations(): Promise<void> {
  for (const category of VO3_MENU) {
    for (const item of category.items) {
      const menuItemId = id(`menu-item:${item.key}`);
      const targetIds = (item.recommendationKeys ?? []).map((key) => id(`menu-item:${key}`));
      await syncMenuItemRecommendations(menuItemId, targetIds);
    }
  }
}

async function main(): Promise<void> {
  validateVo3Recommendations();

  await seedRestaurantSettings();
  await seedAdmin();

  const categoryIds = await seedVo3Categories();
  const menuItemIds = await seedVo3MenuItems(categoryIds);
  await retireLegacyFakeCatalog(new Set(categoryIds.values()), menuItemIds);
  await seedMenuItemRecommendations();

  const itemCount = VO3_MENU.reduce((sum, category) => sum + category.items.length, 0);
  const recommendationCount = VO3_MENU.reduce(
    (sum, category) =>
      sum + category.items.reduce((s, item) => s + (item.recommendationKeys?.length ?? 0), 0),
    0,
  );
  console.log(
    `Seed complete: ${VO3_MENU.length} categories, ${itemCount} menu items, ${recommendationCount} recommendations, 1 restaurant settings row, 1 admin user (no password — provisioned separately).`,
  );
}

// Only run when executed directly (`npm run seed` / `ts-node prisma/seed.ts`),
// not when this module is imported (e.g. by tests exercising
// seedRestaurantSettings() in isolation) — importing must never have the
// side effect of seeding categories/menu items/admin accounts.
if (require.main === module) {
  main()
    .catch((error: unknown) => {
      console.error('Seed failed:', error);
      process.exitCode = 1;
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
