import { IsArray, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class UpdateCartItemDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  // Explicit `null` clears the variant; omitted leaves it unchanged.
  @IsOptional()
  @IsUUID()
  variantId?: string | null;

  // Replaces the full addon selection when present (including `[]` to clear it).
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  addonIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  specialInstructions?: string | null;
}
