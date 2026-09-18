import { PromoCode } from '@prisma/client';
import type { DisplayLine } from '../../modules/pricing/pricing.service';
import {
  AddonResponseDto,
  ItemVariantResponseDto,
  MenuItemResponseDto,
  toMenuItemResponse,
} from './menu-item-response.mapper';

/**
 * Field names chosen from plan §2.15 (no confirmed Flutter PromoCode field
 * list exists yet — flagged D5/D9 in the plan; revisit once the real
 * frontend model is available).
 */
export interface PromoResponseDto {
  code: string;
  discountType: 'PERCENT' | 'FIXED';
  value: number;
  minOrderAmount: number | null;
  maxDiscountAmount: number | null;
}

export function toPromoResponse(promo: PromoCode): PromoResponseDto {
  return {
    code: promo.code,
    discountType: promo.discountType,
    value: promo.value.toNumber(),
    minOrderAmount: promo.minOrderAmount?.toNumber() ?? null,
    maxDiscountAmount: promo.maxDiscountAmount?.toNumber() ?? null,
  };
}

/** Admin view: everything the customer-facing shape omits (usage/limits/window/status). */
export interface AdminPromoResponseDto extends PromoResponseDto {
  id: string;
  maxUsage: number | null;
  usageCount: number;
  perUserLimit: number | null;
  startsAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toAdminPromoResponse(promo: PromoCode): AdminPromoResponseDto {
  return {
    ...toPromoResponse(promo),
    id: promo.id,
    maxUsage: promo.maxUsage,
    usageCount: promo.usageCount,
    perUserLimit: promo.perUserLimit,
    startsAt: promo.startsAt?.toISOString() ?? null,
    expiresAt: promo.expiresAt?.toISOString() ?? null,
    isActive: promo.isActive,
    createdAt: promo.createdAt.toISOString(),
    updatedAt: promo.updatedAt.toISOString(),
  };
}

/** Matches the Flutter `CartItem` model (plan §3.4): full hydrated menuItem,
 * server-computed unitPrice/totalPrice — never accepted on write.
 * `isAvailable` is an additive field: false when this line's item/variant/
 * addon selection is no longer valid (e.g. the item went unavailable after
 * being added) — the line is still returned, not silently dropped, so the
 * customer can see and remove it. */
export interface CartItemResponseDto {
  id: string;
  menuItem: MenuItemResponseDto;
  selectedVariant: ItemVariantResponseDto | null;
  selectedAddons: AddonResponseDto[];
  quantity: number;
  specialInstructions: string | null;
  unitPrice: number;
  totalPrice: number;
  isAvailable: boolean;
}

export function toCartItemResponse(
  id: string,
  specialInstructions: string | null,
  line: DisplayLine,
): CartItemResponseDto {
  return {
    id,
    menuItem: toMenuItemResponse(line.menuItem),
    selectedVariant: line.variant
      ? {
          id: line.variant.id,
          nameAr: line.variant.nameAr,
          nameEn: line.variant.nameEn,
          priceDelta: line.variant.priceDelta.toNumber(),
          isDefault: line.variant.isDefault,
        }
      : null,
    selectedAddons: line.addons.map((addon) => ({
      id: addon.id,
      nameAr: addon.nameAr,
      nameEn: addon.nameEn,
      price: addon.price.toNumber(),
    })),
    quantity: line.quantity,
    specialInstructions,
    unitPrice: line.unitPrice.toNumber(),
    totalPrice: line.lineTotal.toNumber(),
    isAvailable: line.isAvailable,
  };
}

/** Matches the Flutter `Cart` model (plan §3.4). `taxRate` is a flat
 * RestaurantSettings passthrough. `deliveryFee` is always `0` here — no
 * deliveryMethod/deliveryZone exists at the cart stage (both are chosen at
 * checkout), and Phase 8 made the real DELIVERY fee zone-specific, so this
 * response must never guess/default one before a zone is selected. The
 * authoritative per-order deliveryFee only exists on the OrderResponseDto
 * returned by checkout. */
export interface CartResponseDto {
  items: CartItemResponseDto[];
  appliedPromo: PromoResponseDto | null;
  deliveryFee: number;
  taxRate: number;
}
