import { createHash } from 'node:crypto';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaClient } from '@prisma/client';

/**
 * Phase 1 development seed.
 *
 * Idempotent: every row is upserted against a deterministic UUID derived from a
 * stable human-readable key, so re-running this script never creates duplicates
 * and safely refreshes values on each run.
 *
 * Contains only the baseline data required by BACKEND_IMPLEMENTATION_PLAN.md
 * Phase 1: the RestaurantSettings singleton, the initial categories, sample
 * menu items with variants/add-ons, and a seeded admin account. This is
 * representative development data (the original Flutter FakeMenuRepository
 * lives on a separate machine and is out of reach here) — it mirrors its
 * documented shape (6 categories, 10 items with variants/add-ons) per
 * PROJECT_CURRENT_STATE_AUDIT.md §7.
 *
 * No plaintext passwords or production secrets are seeded: the admin account
 * is created with passwordHash = null. Credential provisioning is a Phase 2
 * (Authentication) concern.
 */

const prisma = new PrismaClient();

/** Deterministic, collision-free UUID derived from a stable seed key. */
function id(seedKey: string): string {
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

interface AddonSeed {
  key: string;
  nameAr: string;
  nameEn: string;
  price: number;
}

interface AddonGroupSeed {
  key: string;
  titleAr: string;
  titleEn: string;
  isRequired: boolean;
  minSelect: number;
  maxSelect: number;
  addons: AddonSeed[];
}

interface VariantSeed {
  key: string;
  nameAr: string;
  nameEn: string;
  priceDelta: number;
  isDefault: boolean;
}

interface MenuItemSeed {
  key: string;
  categoryKey: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  basePrice: number;
  isPopular?: boolean;
  variants?: VariantSeed[];
  addonGroups?: AddonGroupSeed[];
}

const CATEGORIES = [
  { key: 'kabsah', nameAr: 'كبسة', nameEn: 'Kabsah', displayOrder: 0 },
  { key: 'kebda', nameAr: 'كبدة', nameEn: 'Kebda', displayOrder: 1 },
  { key: 'alexandrian', nameAr: 'اسكندراني', nameEn: 'Alexandrian', displayOrder: 2 },
  { key: 'extras', nameAr: 'إضافات', nameEn: 'Extras', displayOrder: 3 },
  { key: 'drinks', nameAr: 'مشروبات', nameEn: 'Drinks', displayOrder: 4 },
  { key: 'desserts', nameAr: 'حلويات', nameEn: 'Desserts', displayOrder: 5 },
] as const;

const MENU_ITEMS: MenuItemSeed[] = [
  {
    key: 'kebda-sandwich',
    categoryKey: 'kebda',
    nameAr: 'سندوتش كبدة إسكندراني',
    nameEn: 'Alexandrian Kebda Sandwich',
    descriptionAr: 'كبدة طازة مقلية في زبدة بلدي مع الشطة والدقة',
    descriptionEn: 'Fresh liver sautéed in ghee, served with chili and dukkah',
    basePrice: 45,
    isPopular: true,
    variants: [
      { key: 'regular', nameAr: 'عادي', nameEn: 'Regular', priceDelta: 0, isDefault: true },
      { key: 'large', nameAr: 'كبير', nameEn: 'Large', priceDelta: 15, isDefault: false },
    ],
    addonGroups: [
      {
        key: 'toppings',
        titleAr: 'إضافات',
        titleEn: 'Toppings',
        isRequired: false,
        minSelect: 0,
        maxSelect: 3,
        addons: [
          { key: 'extra-tahini', nameAr: 'طحينة زيادة', nameEn: 'Extra Tahini', price: 5 },
          { key: 'hot-pepper', nameAr: 'فلفل حار', nameEn: 'Hot Pepper', price: 0 },
          { key: 'pickled-onion', nameAr: 'بصل مخلل', nameEn: 'Pickled Onion', price: 0 },
        ],
      },
    ],
  },
  {
    key: 'kebda-plate',
    categoryKey: 'kebda',
    nameAr: 'طبق كبدة',
    nameEn: 'Kebda Plate',
    descriptionAr: 'طبق كبدة كاملة مع أرز وسلطة',
    descriptionEn: 'Full liver plate served with rice and salad',
    basePrice: 80,
    variants: [
      { key: 'half', nameAr: 'نص طبق', nameEn: 'Half Plate', priceDelta: 0, isDefault: true },
      { key: 'full', nameAr: 'طبق كامل', nameEn: 'Full Plate', priceDelta: 35, isDefault: false },
    ],
  },
  {
    key: 'chicken-kabsah',
    categoryKey: 'kabsah',
    nameAr: 'كبسة فراخ',
    nameEn: 'Chicken Kabsah',
    descriptionAr: 'أرز بسمتي بالبهارات مع فراخ مشوية',
    descriptionEn: 'Spiced basmati rice with grilled chicken',
    basePrice: 95,
    isPopular: true,
    variants: [
      { key: 'half', nameAr: 'نص فرخة', nameEn: 'Half Chicken', priceDelta: 0, isDefault: true },
      {
        key: 'full',
        nameAr: 'فرخة كاملة',
        nameEn: 'Full Chicken',
        priceDelta: 40,
        isDefault: false,
      },
    ],
    addonGroups: [
      {
        key: 'extras',
        titleAr: 'إضافات',
        titleEn: 'Extras',
        isRequired: false,
        minSelect: 0,
        maxSelect: 2,
        addons: [
          { key: 'side-salad', nameAr: 'سلطة', nameEn: 'Side Salad', price: 10 },
          { key: 'white-sauce', nameAr: 'صوص أبيض', nameEn: 'White Sauce', price: 5 },
        ],
      },
    ],
  },
  {
    key: 'meat-kabsah',
    categoryKey: 'kabsah',
    nameAr: 'كبسة لحم',
    nameEn: 'Meat Kabsah',
    descriptionAr: 'أرز بسمتي بالبهارات مع قطع لحم ضاني',
    descriptionEn: 'Spiced basmati rice with tender lamb pieces',
    basePrice: 120,
  },
  {
    key: 'alex-sausage',
    categoryKey: 'alexandrian',
    nameAr: 'سندوتش سجق اسكندراني',
    nameEn: 'Alexandrian Sausage Sandwich',
    descriptionAr: 'سجق بلدي حار مقلي في الطماطم والفلفل',
    descriptionEn: 'Spicy homemade sausage sautéed with tomato and pepper',
    basePrice: 40,
    addonGroups: [
      {
        key: 'toppings',
        titleAr: 'إضافات',
        titleEn: 'Toppings',
        isRequired: false,
        minSelect: 0,
        maxSelect: 2,
        addons: [
          { key: 'cheese', nameAr: 'جبنة', nameEn: 'Cheese', price: 8 },
          { key: 'hot-pepper', nameAr: 'فلفل حار', nameEn: 'Hot Pepper', price: 0 },
        ],
      },
    ],
  },
  {
    key: 'alex-fatta',
    categoryKey: 'alexandrian',
    nameAr: 'فتة اسكندراني',
    nameEn: 'Alexandrian Fatta',
    descriptionAr: 'أرز وعيش محمص مع صوص طماطم وثوم وقطع لحمة',
    descriptionEn: 'Rice and toasted bread with tomato-garlic sauce and beef',
    basePrice: 65,
  },
  {
    key: 'fries',
    categoryKey: 'extras',
    nameAr: 'بطاطس محمرة',
    nameEn: 'French Fries',
    descriptionAr: 'بطاطس مقرمشة طازة',
    descriptionEn: 'Crispy fresh-cut fries',
    basePrice: 25,
    variants: [
      { key: 'small', nameAr: 'صغير', nameEn: 'Small', priceDelta: 0, isDefault: true },
      { key: 'large', nameAr: 'كبير', nameEn: 'Large', priceDelta: 10, isDefault: false },
    ],
  },
  {
    key: 'tahini-salad',
    categoryKey: 'extras',
    nameAr: 'سلطة طحينة',
    nameEn: 'Tahini Salad',
    descriptionAr: 'طحينة بلدي بزيت الزيتون',
    descriptionEn: 'Homemade tahini with olive oil',
    basePrice: 15,
  },
  {
    key: 'soft-drink',
    categoryKey: 'drinks',
    nameAr: 'مياه غازية',
    nameEn: 'Soft Drink',
    descriptionAr: 'مشروب غازي بارد 250 مل',
    descriptionEn: 'Chilled 250ml soft drink',
    basePrice: 15,
    variants: [
      { key: 'cola', nameAr: 'كولا', nameEn: 'Cola', priceDelta: 0, isDefault: true },
      { key: 'lemon', nameAr: 'ليمون', nameEn: 'Lemon', priceDelta: 0, isDefault: false },
    ],
  },
  {
    key: 'om-ali',
    categoryKey: 'desserts',
    nameAr: 'أم علي',
    nameEn: 'Om Ali',
    descriptionAr: 'حلوى مصرية تقليدية بالمكسرات والقشطة',
    descriptionEn: 'Traditional Egyptian bread pudding with nuts and cream',
    basePrice: 35,
  },
];

async function seedRestaurantSettings(): Promise<void> {
  await prisma.restaurantSettings.upsert({
    where: { singleton: true },
    update: {
      restaurantName: 'Kebda Zaman',
      phone: '+20100000000',
      addressText: 'Cairo, Egypt',
      taxRatePercent: money(14),
      deliveryFee: money(20),
      minOrderAmount: money(50),
      currency: 'EGP',
      workingHours: { open: '10:00', close: '02:00' },
      isMaintenanceMode: false,
    },
    create: {
      id: id('restaurant-settings:singleton'),
      singleton: true,
      restaurantName: 'Kebda Zaman',
      phone: '+20100000000',
      addressText: 'Cairo, Egypt',
      taxRatePercent: money(14),
      deliveryFee: money(20),
      minOrderAmount: money(50),
      currency: 'EGP',
      workingHours: { open: '10:00', close: '02:00' },
      isMaintenanceMode: false,
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

async function seedCategories(): Promise<Map<string, string>> {
  const categoryIds = new Map<string, string>();

  for (const category of CATEGORIES) {
    const categoryId = id(`category:${category.key}`);
    categoryIds.set(category.key, categoryId);

    await prisma.category.upsert({
      where: { id: categoryId },
      update: {
        nameAr: category.nameAr,
        nameEn: category.nameEn,
        displayOrder: category.displayOrder,
        isActive: true,
      },
      create: {
        id: categoryId,
        nameAr: category.nameAr,
        nameEn: category.nameEn,
        displayOrder: category.displayOrder,
        isActive: true,
      },
    });
  }

  return categoryIds;
}

async function seedMenuItems(categoryIds: Map<string, string>): Promise<void> {
  for (const item of MENU_ITEMS) {
    const categoryId = categoryIds.get(item.categoryKey);
    if (!categoryId) {
      throw new Error(`Unknown category key "${item.categoryKey}" for menu item "${item.key}"`);
    }

    const menuItemId = id(`menu-item:${item.key}`);
    const imageUrl = `https://picsum.photos/seed/kebda-zaman-${item.key}/600/400`;

    await prisma.menuItem.upsert({
      where: { id: menuItemId },
      update: {
        categoryId,
        nameAr: item.nameAr,
        nameEn: item.nameEn,
        descriptionAr: item.descriptionAr,
        descriptionEn: item.descriptionEn,
        basePrice: money(item.basePrice),
        imageUrl,
        isAvailable: true,
        isPopular: item.isPopular ?? false,
      },
      create: {
        id: menuItemId,
        categoryId,
        nameAr: item.nameAr,
        nameEn: item.nameEn,
        descriptionAr: item.descriptionAr,
        descriptionEn: item.descriptionEn,
        basePrice: money(item.basePrice),
        imageUrl,
        isAvailable: true,
        isPopular: item.isPopular ?? false,
      },
    });

    for (const variant of item.variants ?? []) {
      const variantId = id(`variant:${item.key}:${variant.key}`);
      await prisma.itemVariant.upsert({
        where: { id: variantId },
        update: {
          menuItemId,
          nameAr: variant.nameAr,
          nameEn: variant.nameEn,
          priceDelta: money(variant.priceDelta),
          isDefault: variant.isDefault,
          isActive: true,
        },
        create: {
          id: variantId,
          menuItemId,
          nameAr: variant.nameAr,
          nameEn: variant.nameEn,
          priceDelta: money(variant.priceDelta),
          isDefault: variant.isDefault,
          isActive: true,
        },
      });
    }

    for (const group of item.addonGroups ?? []) {
      const groupId = id(`addon-group:${item.key}:${group.key}`);
      await prisma.addonGroup.upsert({
        where: { id: groupId },
        update: {
          menuItemId,
          titleAr: group.titleAr,
          titleEn: group.titleEn,
          isRequired: group.isRequired,
          minSelect: group.minSelect,
          maxSelect: group.maxSelect,
        },
        create: {
          id: groupId,
          menuItemId,
          titleAr: group.titleAr,
          titleEn: group.titleEn,
          isRequired: group.isRequired,
          minSelect: group.minSelect,
          maxSelect: group.maxSelect,
        },
      });

      for (const addon of group.addons) {
        const addonId = id(`addon:${item.key}:${group.key}:${addon.key}`);
        await prisma.addon.upsert({
          where: { id: addonId },
          update: {
            addonGroupId: groupId,
            nameAr: addon.nameAr,
            nameEn: addon.nameEn,
            price: money(addon.price),
            isAvailable: true,
          },
          create: {
            id: addonId,
            addonGroupId: groupId,
            nameAr: addon.nameAr,
            nameEn: addon.nameEn,
            price: money(addon.price),
            isAvailable: true,
          },
        });
      }
    }
  }
}

async function main(): Promise<void> {
  await seedRestaurantSettings();
  await seedAdmin();
  const categoryIds = await seedCategories();
  await seedMenuItems(categoryIds);

  console.log(
    `Seed complete: ${CATEGORIES.length} categories, ${MENU_ITEMS.length} menu items, 1 restaurant settings row, 1 admin user.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
