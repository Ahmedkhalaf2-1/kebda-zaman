import { Injectable } from '@nestjs/common';
import { CartService } from '../cart/cart.service';
import { PricingService } from '../pricing/pricing.service';
import { ValidatePromoDto } from './dto/validate-promo.dto';

export interface ValidatePromoResponseDto {
  valid: true;
  discountType: 'PERCENT' | 'FIXED';
  value: number;
  computedDiscount: number;
}

@Injectable()
export class PromosService {
  constructor(
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
}
