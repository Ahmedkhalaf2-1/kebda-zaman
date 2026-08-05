import { IsBoolean, IsInt, IsNumber, IsOptional, Min } from 'class-validator';

/** Same DTO for create and full-replace update (mirrors the Category/DeliveryZone
 * pattern). Cross-field rules (min < max, no overlap/gap against other active
 * tiers) are enforced in DeliveryPricingService, not here — same convention
 * as SettingsService.assertValidWorkingHours / CheckoutDto.deliveryAddress. */
export class DeliveryDistanceTierDto {
  @IsNumber()
  @Min(0)
  minDistanceKm!: number;

  @IsNumber()
  @Min(0)
  maxDistanceKm!: number;

  @IsNumber()
  @Min(0)
  deliveryFee!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minimumOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
