import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MaxLength,
} from 'class-validator';

/**
 * Same DTO for create and full-replace update (mirrors PromoDto/CategoryDto):
 * omitting an optional field on update clears it, it does not preserve the
 * previous value. `imageUrl` always comes from the existing generic upload
 * endpoint (POST /admin/uploads/image) — to keep the current image on update,
 * the caller resends the same URL; a fresh upload replaces it.
 */
export class MenuOfferDto {
  @IsUUID()
  menuItemId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  imageUrl!: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsDateString()
  endAt?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
