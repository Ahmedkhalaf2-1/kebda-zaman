import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { DeliveryMethod, PaymentMethod } from '@prisma/client';

export class DeliveryAddressDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  street!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  building!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  floor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  apartment?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city!: string;
}

/** No monetary fields — the server recomputes everything (plan §4.11/§6). */
export class CheckoutDto {
  @IsEnum(DeliveryMethod)
  deliveryMethod!: DeliveryMethod;

  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  // Required when deliveryMethod=DELIVERY (service-level check — the
  // Address entity itself is out of scope for this phase, see plan D-notes;
  // only an inline address is supported, no saved-address lookup by id).
  @IsOptional()
  @ValidateNested()
  @Type(() => DeliveryAddressDto)
  deliveryAddress?: DeliveryAddressDto;

  // Required when deliveryMethod=DELIVERY (service-level check, same
  // convention as deliveryAddress above) — the backend resolves the actual
  // deliveryFee/minimumOrder from this zone; a client-supplied fee is never
  // trusted. Ignored for PICKUP.
  @IsOptional()
  @IsUUID()
  deliveryZoneId?: string;

  // Mutually exclusive with `redeemRewardId` — a checkout may use a promo
  // code OR redeem a loyalty reward, never both. Enforced in
  // OrdersService.checkout (service-level, matching this file's existing
  // convention of DTO-level shape validation + service-level business
  // rules), not here at the DTO layer.
  @IsOptional()
  @IsString()
  @MaxLength(50)
  promoCode?: string;

  // Redeems a fixed-catalog loyalty reward (see LOYALTY_REWARDS in
  // loyalty.service.ts) atomically as part of this checkout — the points
  // are spent, and the order created, in the same DB transaction, so a
  // failure anywhere in checkout leaves the customer's point balance
  // untouched. Mutually exclusive with `promoCode` (422 if both are sent).
  // Not available to guest accounts (403 GUEST_NOT_ELIGIBLE).
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  redeemRewardId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
