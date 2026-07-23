import { IsArray, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class AddCartItemDto {
  @IsUUID()
  menuItemId!: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  addonIds?: string[];

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  specialInstructions?: string;
}
