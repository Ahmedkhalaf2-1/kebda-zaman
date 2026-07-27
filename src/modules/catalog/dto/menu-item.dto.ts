import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class VariantDto {
  // Present when updating an existing variant; absent when adding a new one.
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nameAr!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nameEn!: string;

  @IsNumber()
  priceDelta!: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}

export class AddonDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nameAr!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nameEn!: string;

  @IsNumber()
  @Min(0)
  price!: number;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}

export class AddonGroupDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  titleAr!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  titleEn!: string;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  minSelect?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxSelect?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AddonDto)
  addons!: AddonDto[];
}

/** Create/update body (plan §4.18: "MenuItemDto (+variants+addonGroups)"). */
export class MenuItemDto {
  @IsUUID()
  categoryId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  nameAr!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  nameEn!: string;

  @IsString()
  @IsNotEmpty()
  descriptionAr!: string;

  @IsString()
  @IsNotEmpty()
  descriptionEn!: string;

  @IsNumber()
  @Min(0)
  basePrice!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  imageUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @IsOptional()
  @IsBoolean()
  isPopular?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VariantDto)
  variants?: VariantDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AddonGroupDto)
  addonGroups?: AddonGroupDto[];
}
