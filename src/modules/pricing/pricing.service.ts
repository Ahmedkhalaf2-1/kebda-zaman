import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DeliveryMethod, Prisma, PromoCode, RestaurantSettings } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MenuItemWithRelations,
  PUBLIC_MENU_ITEM_INCLUDE,
} from '../../common/mappers/menu-item-response.mapper';

export interface CartLineInput {
  menuItemId: string;
  variantId?: string | null;
  addonIds: string[];
  quantity: number;
}

type Variant = MenuItemWithRelations['variants'][number];
type Addon = MenuItemWithRelations['addonGroups'][number]['addons'][number];

export interface PricedLine {
  menuItem: MenuItemWithRelations;
  variant: Variant | null;
  addons: Addon[];
  quantity: number;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

export interface PriceLinesResult {
  lines: PricedLine[];
  subtotal: Prisma.Decimal;
}

/** A PricedLine plus an explicit availability flag, for read-only display. */
export interface DisplayLine extends PricedLine {
  isAvailable: boolean;
}

export interface PromoEvaluation {
  promo: PromoCode;
  discount: Prisma.Decimal;
}

export interface FullPriceBreakdown {
  lines: PricedLine[];
  subtotal: Prisma.Decimal;
  discount: Prisma.Decimal;
  tax: Prisma.Decimal;
  deliveryFee: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  currency: string;
  /** The resolved promo, when a code was applied — needed by checkout to
   * persist appliedPromoId/promoCodeSnapshot and to guard usageCount. */
  promo: PromoCode | null;
}

function round2(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Authoritative server-side pricing (plan §6). The client may only ever send
 * references (menuItemId/variantId/addonIds) and a quantity — every money
 * figure here is derived fresh from the database on every call. No method on
 * this service accepts a price, subtotal, tax, fee, or total as input.
 */
@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  async priceLines(inputs: CartLineInput[]): Promise<PriceLinesResult> {
    if (inputs.length === 0) {
      return { lines: [], subtotal: new Prisma.Decimal(0) };
    }

    const menuItemIds = [...new Set(inputs.map((input) => input.menuItemId))];
    const menuItems = await this.prisma.menuItem.findMany({
      where: { id: { in: menuItemIds } },
      include: PUBLIC_MENU_ITEM_INCLUDE,
    });
    const menuItemsById = new Map(menuItems.map((item) => [item.id, item]));

    const lines = inputs.map((input) => this.priceLine(input, menuItemsById));
    const subtotal = lines.reduce((sum, line) => sum.plus(line.lineTotal), new Prisma.Decimal(0));
    return { lines, subtotal };
  }

  /**
   * Lenient counterpart to `priceLines`, for read-only cart display only.
   * Never throws for a stale line — if the item is now unavailable/deleted,
   * or its previously-selected variant/addon is no longer valid, that line
   * is degraded to `isAvailable: false` with a zeroed price instead of
   * failing the whole batch, so the cart can still be read and the customer
   * can see/remove the stale line. This method must NEVER be used to
   * authorize a price: cart mutations and checkout must keep using the
   * strict `priceLines`/`priceCart` above.
   */
  async priceLinesForDisplay(inputs: CartLineInput[]): Promise<{ lines: DisplayLine[] }> {
    if (inputs.length === 0) {
      return { lines: [] };
    }

    const menuItemIds = [...new Set(inputs.map((input) => input.menuItemId))];
    const menuItems = await this.prisma.menuItem.findMany({
      where: { id: { in: menuItemIds } },
      include: PUBLIC_MENU_ITEM_INCLUDE,
    });
    const menuItemsById = new Map(menuItems.map((item) => [item.id, item]));

    const lines = inputs.map((input): DisplayLine => {
      const menuItem = menuItemsById.get(input.menuItemId);
      if (!menuItem) {
        // Should not happen: CartItem.menuItemId is a Restrict FK, so a
        // referenced MenuItem row can never be gone. Defensive only.
        throw new NotFoundException({
          message: 'Menu item is unavailable',
          code: 'ITEM_UNAVAILABLE',
        });
      }

      try {
        const priced = this.priceLine(input, menuItemsById);
        return { ...priced, isAvailable: true };
      } catch {
        return {
          menuItem: { ...menuItem, isAvailable: false },
          variant: null,
          addons: [],
          quantity: input.quantity,
          unitPrice: new Prisma.Decimal(0),
          lineTotal: new Prisma.Decimal(0),
          isAvailable: false,
        };
      }
    });

    return { lines };
  }

  private priceLine(
    input: CartLineInput,
    menuItemsById: Map<string, MenuItemWithRelations>,
  ): PricedLine {
    const menuItem = menuItemsById.get(input.menuItemId);
    if (!menuItem || !menuItem.isAvailable || menuItem.deletedAt) {
      throw new NotFoundException({
        message: 'Menu item is unavailable',
        code: 'ITEM_UNAVAILABLE',
      });
    }

    const variant = this.resolveVariant(menuItem, input.variantId);
    const addons = this.resolveAddons(menuItem, input.addonIds ?? []);

    const unitPrice = round2(
      menuItem.basePrice
        .plus(variant?.priceDelta ?? 0)
        .plus(addons.reduce((sum, addon) => sum.plus(addon.price), new Prisma.Decimal(0))),
    );
    const lineTotal = round2(unitPrice.times(input.quantity));

    return { menuItem, variant, addons, quantity: input.quantity, unitPrice, lineTotal };
  }

  private resolveVariant(
    menuItem: MenuItemWithRelations,
    variantId?: string | null,
  ): Variant | null {
    if (variantId) {
      const variant = menuItem.variants.find((candidate) => candidate.id === variantId);
      if (!variant) {
        throw new UnprocessableEntityException({
          message: 'Selected variant does not belong to this item or is inactive',
          code: 'INVALID_VARIANT',
        });
      }
      return variant;
    }

    if (menuItem.variants.length === 0) {
      return null;
    }

    const defaultVariant = menuItem.variants.find((candidate) => candidate.isDefault);
    if (!defaultVariant) {
      throw new UnprocessableEntityException({
        message: 'A variant selection is required for this item',
        code: 'INVALID_VARIANT',
      });
    }
    return defaultVariant;
  }

  private resolveAddons(menuItem: MenuItemWithRelations, addonIds: string[]): Addon[] {
    const uniqueAddonIds = [...new Set(addonIds)];
    const catalog = menuItem.addonGroups.flatMap((group) =>
      group.addons.map((addon) => ({ addon, group })),
    );

    const selected = uniqueAddonIds.map((id) => {
      const match = catalog.find((entry) => entry.addon.id === id);
      if (!match) {
        throw new UnprocessableEntityException({
          message: 'Selected addon does not belong to this item or is unavailable',
          code: 'INVALID_ADDON_SELECTION',
        });
      }
      return match;
    });

    for (const group of menuItem.addonGroups) {
      const count = selected.filter((entry) => entry.group.id === group.id).length;
      if (count < group.minSelect || count > group.maxSelect || (group.isRequired && count === 0)) {
        throw new UnprocessableEntityException({
          message: `"${group.titleEn}" requires between ${group.minSelect} and ${group.maxSelect} selection(s)`,
          code: 'INVALID_ADDON_SELECTION',
        });
      }
    }

    return selected.map((entry) => entry.addon);
  }

  async evaluatePromo(code: string, subtotal: Prisma.Decimal): Promise<PromoEvaluation> {
    const promo = await this.prisma.promoCode.findFirst({
      where: { code: code.trim().toUpperCase(), deletedAt: null },
    });
    if (!promo) {
      throw new NotFoundException({ message: 'Promo code not found', code: 'PROMO_NOT_FOUND' });
    }

    const now = new Date();
    if (!promo.isActive || (promo.startsAt && promo.startsAt > now)) {
      throw new UnprocessableEntityException({
        message: 'Promo code is not currently active',
        code: 'PROMO_INVALID',
      });
    }
    if (promo.expiresAt && promo.expiresAt < now) {
      throw new UnprocessableEntityException({
        message: 'Promo code has expired',
        code: 'PROMO_EXPIRED',
      });
    }
    if (promo.maxUsage !== null && promo.usageCount >= promo.maxUsage) {
      throw new UnprocessableEntityException({
        message: 'Promo code has been fully redeemed',
        code: 'PROMO_INVALID',
      });
    }
    if (promo.minOrderAmount && subtotal.lessThan(promo.minOrderAmount)) {
      throw new UnprocessableEntityException({
        message: `Minimum order amount of ${promo.minOrderAmount.toString()} not met`,
        code: 'PROMO_MIN_ORDER',
      });
    }

    let discount: Prisma.Decimal;
    if (promo.discountType === 'PERCENT') {
      discount = subtotal.times(promo.value).dividedBy(100);
      if (promo.maxDiscountAmount && discount.greaterThan(promo.maxDiscountAmount)) {
        discount = promo.maxDiscountAmount;
      }
    } else {
      discount = Prisma.Decimal.min(promo.value, subtotal);
    }

    return { promo, discount: round2(discount) };
  }

  /**
   * Full breakdown (plan §6.2 steps 1-8) — the reusable core for order
   * checkout (Phase 5). Not yet wired to any Phase 4 HTTP endpoint: the Cart
   * view has no deliveryMethod (that's chosen at checkout), so cart responses
   * only surface flat settings.deliveryFee/taxRatePercent (see CartService).
   */
  async priceCart(
    inputs: CartLineInput[],
    settings: RestaurantSettings,
    deliveryMethod: DeliveryMethod,
    promoCode?: string | null,
  ): Promise<FullPriceBreakdown> {
    const { lines, subtotal } = await this.priceLines(inputs);

    let discount = new Prisma.Decimal(0);
    let promo: PromoCode | null = null;
    if (promoCode) {
      const evaluation = await this.evaluatePromo(promoCode, subtotal);
      discount = evaluation.discount;
      promo = evaluation.promo;
    }

    const deliveryFee =
      deliveryMethod === DeliveryMethod.PICKUP ? new Prisma.Decimal(0) : settings.deliveryFee;
    const { tax, totalAmount } = this.computeTotals(
      subtotal,
      discount,
      deliveryFee,
      settings.taxRatePercent,
    );

    return {
      lines,
      subtotal,
      discount,
      tax,
      deliveryFee,
      totalAmount,
      currency: settings.currency,
      promo,
    };
  }

  /**
   * Layers an additional discount and/or a delivery-fee override onto an
   * already-priced breakdown, recomputing tax/total through the exact same
   * formula `priceCart` uses — the single source of truth for that math, so
   * a second discount source (e.g. a loyalty reward, see
   * `LoyaltyService.evaluateRedemption`) can never drift from how a promo
   * discount is applied. Additive on top of whatever discount is already on
   * the breakdown (usually `0`, since promo and loyalty are mutually
   * exclusive at checkout — see OrdersService.checkout) rather than
   * assuming it starts at zero, so this stays composable if that ever
   * changes. Does not mutate the input breakdown.
   */
  applyDiscount(
    breakdown: FullPriceBreakdown,
    settings: RestaurantSettings,
    extraDiscount: Prisma.Decimal,
    deliveryFeeOverride?: Prisma.Decimal,
  ): FullPriceBreakdown {
    const discount = breakdown.discount.plus(extraDiscount);
    const deliveryFee = deliveryFeeOverride ?? breakdown.deliveryFee;
    const { tax, totalAmount } = this.computeTotals(
      breakdown.subtotal,
      discount,
      deliveryFee,
      settings.taxRatePercent,
    );

    return { ...breakdown, discount, deliveryFee, tax, totalAmount };
  }

  private computeTotals(
    subtotal: Prisma.Decimal,
    discount: Prisma.Decimal,
    deliveryFee: Prisma.Decimal,
    taxRatePercent: Prisma.Decimal,
  ): { tax: Prisma.Decimal; totalAmount: Prisma.Decimal } {
    const discountedSubtotal = subtotal.minus(discount);
    const tax = round2(discountedSubtotal.times(taxRatePercent).dividedBy(100));
    const totalAmount = discountedSubtotal.plus(tax).plus(deliveryFee);
    return { tax, totalAmount };
  }
}
