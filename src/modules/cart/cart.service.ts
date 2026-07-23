import { Injectable, NotFoundException } from '@nestjs/common';
import { Cart, CartItem, CartItemAddon } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PricingService, CartLineInput } from '../pricing/pricing.service';
import { SettingsService } from '../settings/settings.service';
import {
  CartResponseDto,
  PromoResponseDto,
  toCartItemResponse,
  toPromoResponse,
} from '../../common/mappers/cart-response.mapper';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';

type CartItemWithAddons = CartItem & { addons: CartItemAddon[] };

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricingService: PricingService,
    private readonly settingsService: SettingsService,
  ) {}

  /** One persistent cart per user, created on first access. */
  async getOrCreateCart(userId: string): Promise<Cart> {
    return this.prisma.cart.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
  }

  private async loadItems(cartId: string): Promise<CartItemWithAddons[]> {
    return this.prisma.cartItem.findMany({
      where: { cartId },
      include: { addons: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  private toInputs(items: CartItemWithAddons[]): CartLineInput[] {
    return items.map((item) => ({
      menuItemId: item.menuItemId,
      variantId: item.selectedVariantId,
      addonIds: item.addons.map((addon) => addon.addonId),
      quantity: item.quantity,
    }));
  }

  /** Used by PromosService to price the caller's own current cart. */
  async getCartLineInputs(userId: string): Promise<CartLineInput[]> {
    const cart = await this.getOrCreateCart(userId);
    return this.toInputs(await this.loadItems(cart.id));
  }

  private async buildResponse(
    cartId: string,
    appliedPromoId: string | null,
  ): Promise<CartResponseDto> {
    const items = await this.loadItems(cartId);
    const inputs = this.toInputs(items);

    // Lenient on purpose: rendering the cart must never fail just because a
    // previously-added item/variant/addon has since gone stale (plan fix —
    // see PricingService.priceLinesForDisplay). Mutations below still use
    // the strict `priceLines` to validate the specific line being changed.
    const [{ lines }, settings] = await Promise.all([
      this.pricingService.priceLinesForDisplay(inputs),
      this.settingsService.getSettings(),
    ]);

    let appliedPromo: PromoResponseDto | null = null;
    if (appliedPromoId) {
      const promo = await this.prisma.promoCode.findUnique({ where: { id: appliedPromoId } });
      appliedPromo = promo ? toPromoResponse(promo) : null;
    }

    return {
      items: items.map((item, index) =>
        toCartItemResponse(item.id, item.specialInstructions, lines[index]),
      ),
      appliedPromo,
      deliveryFee: settings.deliveryFee.toNumber(),
      taxRate: settings.taxRatePercent.toNumber(),
    };
  }

  async getCart(userId: string): Promise<CartResponseDto> {
    const cart = await this.getOrCreateCart(userId);
    return this.buildResponse(cart.id, cart.appliedPromoId);
  }

  async addItem(userId: string, dto: AddCartItemDto): Promise<CartResponseDto> {
    const cart = await this.getOrCreateCart(userId);
    const addonIds = dto.addonIds ?? [];

    // Validates availability/variant/addon rules before persisting anything.
    await this.pricingService.priceLines([
      {
        menuItemId: dto.menuItemId,
        variantId: dto.variantId ?? null,
        addonIds,
        quantity: dto.quantity,
      },
    ]);

    await this.prisma.cartItem.create({
      data: {
        cartId: cart.id,
        menuItemId: dto.menuItemId,
        selectedVariantId: dto.variantId ?? null,
        quantity: dto.quantity,
        specialInstructions: dto.specialInstructions,
        addons:
          addonIds.length > 0 ? { create: addonIds.map((addonId) => ({ addonId })) } : undefined,
      },
    });

    return this.buildResponse(cart.id, cart.appliedPromoId);
  }

  async updateItem(
    userId: string,
    cartItemId: string,
    dto: UpdateCartItemDto,
  ): Promise<CartResponseDto> {
    const cart = await this.getOrCreateCart(userId);
    const existing = await this.prisma.cartItem.findFirst({
      where: { id: cartItemId, cartId: cart.id },
      include: { addons: true },
    });
    if (!existing) {
      throw new NotFoundException({ message: 'Cart item not found', code: 'CART_ITEM_NOT_FOUND' });
    }

    const effectiveVariantId =
      dto.variantId !== undefined ? dto.variantId : existing.selectedVariantId;
    const effectiveAddonIds =
      dto.addonIds !== undefined ? dto.addonIds : existing.addons.map((addon) => addon.addonId);
    const effectiveQuantity = dto.quantity ?? existing.quantity;
    const effectiveInstructions =
      dto.specialInstructions !== undefined
        ? dto.specialInstructions
        : existing.specialInstructions;

    // Re-validates the merged (existing + patch) selection before committing.
    await this.pricingService.priceLines([
      {
        menuItemId: existing.menuItemId,
        variantId: effectiveVariantId,
        addonIds: effectiveAddonIds,
        quantity: effectiveQuantity,
      },
    ]);

    await this.prisma.$transaction(async (tx) => {
      if (dto.addonIds !== undefined) {
        await tx.cartItemAddon.deleteMany({ where: { cartItemId } });
        if (dto.addonIds.length > 0) {
          await tx.cartItemAddon.createMany({
            data: dto.addonIds.map((addonId) => ({ cartItemId, addonId })),
          });
        }
      }
      await tx.cartItem.update({
        where: { id: cartItemId },
        data: {
          selectedVariantId: effectiveVariantId,
          quantity: effectiveQuantity,
          specialInstructions: effectiveInstructions,
        },
      });
    });

    return this.buildResponse(cart.id, cart.appliedPromoId);
  }

  async removeItem(userId: string, cartItemId: string): Promise<CartResponseDto> {
    const cart = await this.getOrCreateCart(userId);
    const existing = await this.prisma.cartItem.findFirst({
      where: { id: cartItemId, cartId: cart.id },
    });
    if (!existing) {
      throw new NotFoundException({ message: 'Cart item not found', code: 'CART_ITEM_NOT_FOUND' });
    }
    await this.prisma.cartItem.delete({ where: { id: cartItemId } });
    return this.buildResponse(cart.id, cart.appliedPromoId);
  }

  async clearCart(userId: string): Promise<CartResponseDto> {
    const cart = await this.getOrCreateCart(userId);
    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    return this.buildResponse(cart.id, cart.appliedPromoId);
  }

  async applyPromo(userId: string, code: string): Promise<CartResponseDto> {
    const cart = await this.getOrCreateCart(userId);
    const inputs = this.toInputs(await this.loadItems(cart.id));
    const { subtotal } = await this.pricingService.priceLines(inputs);
    const { promo } = await this.pricingService.evaluatePromo(code, subtotal);

    await this.prisma.cart.update({ where: { id: cart.id }, data: { appliedPromoId: promo.id } });
    return this.buildResponse(cart.id, promo.id);
  }

  async removePromo(userId: string): Promise<CartResponseDto> {
    const cart = await this.getOrCreateCart(userId);
    await this.prisma.cart.update({ where: { id: cart.id }, data: { appliedPromoId: null } });
    return this.buildResponse(cart.id, null);
  }
}
