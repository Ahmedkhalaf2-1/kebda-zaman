import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
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

  @IsOptional()
  @IsString()
  @MaxLength(50)
  promoCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
