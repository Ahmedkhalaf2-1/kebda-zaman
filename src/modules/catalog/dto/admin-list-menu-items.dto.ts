import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** plan §4.18: `?q&categoryId` — admin sees unavailable items too. */
export class AdminListMenuItemsDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  q?: string;
}
