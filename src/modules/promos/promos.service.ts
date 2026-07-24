import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CartService } from '../cart/cart.service';
import { PricingService } from '../pricing/pricing.service';
import {
  AdminPromoResponseDto,
  toAdminPromoResponse,
} from '../../common/mappers/cart-response.mapper';
import { ValidatePromoDto } from './dto/validate-promo.dto';
import { PromoDto } from './dto/promo.dto';

export interface ValidatePromoResponseDto {
  valid: true;
  discountType: 'PERCENT' | 'FIXED';
  value: number;
  computedDiscount: number;
}

@Injectable()
export class PromosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cartService: CartService,
    private readonly pricingService: PricingService,
  ) {}

  /** Prices the caller's real cart server-side; the DTO's `subtotal` is never used. */
  async validate(userId: string, dto: ValidatePromoDto): Promise<ValidatePromoResponseDto> {
    const inputs = await this.cartService.getCartLineInputs(userId);
    const { subtotal } = await this.pricingService.priceLines(inputs);
    const { promo, discount } = await this.pricingService.evaluatePromo(dto.code, subtotal);

    return {
      valid: true,
      discountType: promo.discountType,
      value: promo.value.toNumber(),
      computedDiscount: discount.toNumber(),
    };
  }

  // ===========================================================================
  // Admin (plan §4.21)
  // ===========================================================================

  async adminList(): Promise<AdminPromoResponseDto[]> {
    const promos = await this.prisma.promoCode.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return promos.map(toAdminPromoResponse);
  }

  async create(dto: PromoDto): Promise<AdminPromoResponseDto> {
    const code = this.normalizeCode(dto.code);
    await this.assertCodeAvailable(code);

    const created = await this.prisma.promoCode.create({
      data: {
        code,
        discountType: dto.discountType,
        value: dto.value,
        minOrderAmount: dto.minOrderAmount,
        maxDiscountAmount: dto.maxDiscountAmount,
        maxUsage: dto.maxUsage,
        perUserLimit: dto.perUserLimit,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        isActive: dto.isActive ?? true,
      },
    });
    return toAdminPromoResponse(created);
  }

  /** Full replace (plan §4.21) — preserves the exact code normalization `evaluatePromo` (Phase 4) uses for lookup. */
  async update(id: string, dto: PromoDto): Promise<AdminPromoResponseDto> {
    const existing = await this.prisma.promoCode.findFirst({ where: { id, deletedAt: null } });
    if (!existing) {
      throw new NotFoundException({ message: 'Promo code not found', code: 'PROMO_NOT_FOUND' });
    }
    const code = this.normalizeCode(dto.code);
    if (code !== existing.code) {
      await this.assertCodeAvailable(code, id);
    }

    const updated = await this.prisma.promoCode.update({
      where: { id },
      data: {
        code,
        discountType: dto.discountType,
        value: dto.value,
        minOrderAmount: dto.minOrderAmount ?? null,
        maxDiscountAmount: dto.maxDiscountAmount ?? null,
        maxUsage: dto.maxUsage ?? null,
        perUserLimit: dto.perUserLimit ?? null,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        isActive: dto.isActive ?? existing.isActive,
      },
    });
    return toAdminPromoResponse(updated);
  }

  /** Soft delete — evaluatePromo (Phase 4) already filters deletedAt:null, so this takes effect immediately. */
  async remove(id: string): Promise<void> {
    const existing = await this.prisma.promoCode.findFirst({ where: { id, deletedAt: null } });
    if (!existing) {
      throw new NotFoundException({ message: 'Promo code not found', code: 'PROMO_NOT_FOUND' });
    }
    await this.prisma.promoCode.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  private normalizeCode(code: string): string {
    return code.trim().toUpperCase();
  }

  private async assertCodeAvailable(code: string, excludingId?: string): Promise<void> {
    const collision = await this.prisma.promoCode.findFirst({
      where: { code, deletedAt: null, ...(excludingId ? { id: { not: excludingId } } : {}) },
    });
    if (collision) {
      throw new ConflictException({
        message: 'A promo code with this code already exists',
        code: 'PROMO_CODE_EXISTS',
      });
    }
  }
}
