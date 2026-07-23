import { Prisma } from '@prisma/client';

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
  imageUrl: string;
  isAvailable: boolean;
  isPopular: boolean;
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
    imageUrl: item.imageUrl,
    isAvailable: item.isAvailable,
    isPopular: item.isPopular,
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
