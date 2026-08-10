import { MenuItem, MenuItemBadge, Prisma } from '@prisma/client';

/**
 * Public catalog shape. Field-picked explicitly (never spread) so Prisma's
 * Decimal fields are converted with `.toNumber()` — Decimal's default
 * `toJSON()` serializes as a STRING, which would silently break the
 * frontend's `double` fields (plan §3.1 ⚠).
 */
export interface ItemVariantResponseDto {
  id: string;
  nameAr: string;
  nameEn: string;
  priceDelta: number;
  isDefault: boolean;
}

export interface AddonResponseDto {
  id: string;
  nameAr: string;
  nameEn: string;
  price: number;
}

export interface AddonGroupResponseDto {
  id: string;
  titleAr: string;
  titleEn: string;
  isRequired: boolean;
  minSelect: number;
  maxSelect: number;
  addons: AddonResponseDto[];
}

export interface MenuItemResponseDto {
  id: string;
  categoryId: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  basePrice: number;
  // The actual charged price when set (PricingService.resolveMenuItemPrice) —
  // null means no discount, basePrice is charged as-is. Distinct from
  // compareAtPrice (cosmetic "was" price, never read by pricing/financial code).
  salePrice: number | null;
  calories: number | null;
  compareAtPrice: number | null;
  imageUrl: string | null;
  isAvailable: boolean;
  isPopular: boolean;
  badge: MenuItemBadge | null;
  variants: ItemVariantResponseDto[];
  addonGroups: AddonGroupResponseDto[];
}

/** Only active variants / available addons are exposed publicly (catalog + cart hydration). */
export const PUBLIC_MENU_ITEM_INCLUDE = {
  variants: {
    where: { isActive: true },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
  },
  addonGroups: {
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    include: {
      addons: {
        where: { isAvailable: true },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      },
    },
  },
} satisfies Prisma.MenuItemInclude;

export type MenuItemWithRelations = Prisma.MenuItemGetPayload<{
  include: {
    variants: true;
    addonGroups: { include: { addons: true } };
  };
}>;

export function toMenuItemResponse(item: MenuItemWithRelations): MenuItemResponseDto {
  return {
    id: item.id,
    categoryId: item.categoryId,
    nameAr: item.nameAr,
    nameEn: item.nameEn,
    descriptionAr: item.descriptionAr,
    descriptionEn: item.descriptionEn,
    basePrice: item.basePrice.toNumber(),
    salePrice: item.salePrice === null ? null : item.salePrice.toNumber(),
    calories: item.calories,
    compareAtPrice: item.compareAtPrice === null ? null : item.compareAtPrice.toNumber(),
    imageUrl: item.imageUrl,
    isAvailable: item.isAvailable,
    isPopular: item.isPopular,
    badge: item.badge,
    variants: item.variants.map((variant) => ({
      id: variant.id,
      nameAr: variant.nameAr,
      nameEn: variant.nameEn,
      priceDelta: variant.priceDelta.toNumber(),
      isDefault: variant.isDefault,
    })),
    addonGroups: item.addonGroups.map((group) => ({
      id: group.id,
      titleAr: group.titleAr,
      titleEn: group.titleEn,
      isRequired: group.isRequired,
      minSelect: group.minSelect,
      maxSelect: group.maxSelect,
      addons: group.addons.map((addon) => ({
        id: addon.id,
        nameAr: addon.nameAr,
        nameEn: addon.nameEn,
        price: addon.price.toNumber(),
      })),
    })),
  };
}

/**
 * Focused "Often Ordered With" summary — deliberately excludes variants,
 * addonGroups, recommendationItemIds, and oftenOrderedWith itself (no
 * recursive nesting). Public detail endpoint only (plan VO3 Menu §8).
 */
export interface MenuItemSummaryResponseDto {
  id: string;
  categoryId: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  basePrice: number;
  salePrice: number | null;
  compareAtPrice: number | null;
  calories: number | null;
  badge: MenuItemBadge | null;
  imageUrl: string | null;
  isAvailable: boolean;
  isPopular: boolean;
}

export function toMenuItemSummaryResponse(item: MenuItem): MenuItemSummaryResponseDto {
  return {
    id: item.id,
    categoryId: item.categoryId,
    nameAr: item.nameAr,
    nameEn: item.nameEn,
    descriptionAr: item.descriptionAr,
    descriptionEn: item.descriptionEn,
    basePrice: item.basePrice.toNumber(),
    salePrice: item.salePrice === null ? null : item.salePrice.toNumber(),
    compareAtPrice: item.compareAtPrice === null ? null : item.compareAtPrice.toNumber(),
    calories: item.calories,
    badge: item.badge,
    imageUrl: item.imageUrl,
    isAvailable: item.isAvailable,
    isPopular: item.isPopular,
  };
}

/** GET /menu/items/:id only — list/search/featured stay on MenuItemResponseDto. */
export interface MenuItemDetailResponseDto extends MenuItemResponseDto {
  oftenOrderedWith: MenuItemSummaryResponseDto[];
}

export function toMenuItemDetailResponse(
  item: MenuItemWithRelations,
  oftenOrderedWithItems: MenuItem[],
): MenuItemDetailResponseDto {
  return {
    ...toMenuItemResponse(item),
    oftenOrderedWith: oftenOrderedWithItems.map(toMenuItemSummaryResponse),
  };
}

/**
 * Admin view: every variant/addon (active or not — the public
 * PUBLIC_MENU_ITEM_INCLUDE filters those out), plus the isActive/
 * isAvailable/displayOrder fields admin management needs to see and toggle.
 */
export interface AdminItemVariantResponseDto extends ItemVariantResponseDto {
  isActive: boolean;
  displayOrder: number | null;
}

export interface AdminAddonResponseDto extends AddonResponseDto {
  isAvailable: boolean;
  displayOrder: number | null;
}

export interface AdminAddonGroupResponseDto {
  id: string;
  titleAr: string;
  titleEn: string;
  isRequired: boolean;
  minSelect: number;
  maxSelect: number;
  displayOrder: number | null;
  addons: AdminAddonResponseDto[];
}

export interface AdminMenuItemResponseDto extends Omit<
  MenuItemResponseDto,
  'variants' | 'addonGroups'
> {
  displayOrder: number | null;
  variants: AdminItemVariantResponseDto[];
  addonGroups: AdminAddonGroupResponseDto[];
  /** Outgoing "Often Ordered With" target IDs only, ordered by displayOrder — never expanded. */
  recommendationItemIds: string[];
}

export const ADMIN_MENU_ITEM_INCLUDE = {
  variants: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }] },
  addonGroups: {
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    include: { addons: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }] } },
  },
  recommendations: {
    orderBy: { displayOrder: 'asc' },
    select: { recommendedMenuItemId: true },
  },
} satisfies Prisma.MenuItemInclude;

export type AdminMenuItemWithRelations = Prisma.MenuItemGetPayload<{
  include: {
    variants: true;
    addonGroups: { include: { addons: true } };
    recommendations: { select: { recommendedMenuItemId: true } };
  };
}>;

export function toAdminMenuItemResponse(
  item: AdminMenuItemWithRelations,
): AdminMenuItemResponseDto {
  return {
    id: item.id,
    categoryId: item.categoryId,
    nameAr: item.nameAr,
    nameEn: item.nameEn,
    descriptionAr: item.descriptionAr,
    descriptionEn: item.descriptionEn,
    basePrice: item.basePrice.toNumber(),
    salePrice: item.salePrice === null ? null : item.salePrice.toNumber(),
    calories: item.calories,
    compareAtPrice: item.compareAtPrice === null ? null : item.compareAtPrice.toNumber(),
    imageUrl: item.imageUrl,
    isAvailable: item.isAvailable,
    isPopular: item.isPopular,
    badge: item.badge,
    displayOrder: item.displayOrder,
    recommendationItemIds: item.recommendations.map((r) => r.recommendedMenuItemId),
    variants: item.variants.map((variant) => ({
      id: variant.id,
      nameAr: variant.nameAr,
      nameEn: variant.nameEn,
      priceDelta: variant.priceDelta.toNumber(),
      isDefault: variant.isDefault,
      isActive: variant.isActive,
      displayOrder: variant.displayOrder,
    })),
    addonGroups: item.addonGroups.map((group) => ({
      id: group.id,
      titleAr: group.titleAr,
      titleEn: group.titleEn,
      isRequired: group.isRequired,
      minSelect: group.minSelect,
      maxSelect: group.maxSelect,
      displayOrder: group.displayOrder,
      addons: group.addons.map((addon) => ({
        id: addon.id,
        nameAr: addon.nameAr,
        nameEn: addon.nameEn,
        price: addon.price.toNumber(),
        isAvailable: addon.isAvailable,
        displayOrder: addon.displayOrder,
      })),
    })),
  };
}
