import { IsBoolean, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min, MaxLength } from 'class-validator';

/** Same DTO for create and full-replace update (mirrors the Category/PromoCode pattern). */
export class DeliveryZoneDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  nameAr!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  nameEn!: string;

  @IsNumber()
  @Min(0)
  deliveryFee!: number;

  @IsNumber()
  @Min(0)
  minimumOrder!: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
