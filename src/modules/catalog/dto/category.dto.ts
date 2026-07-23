import { IsInt, IsNotEmpty, IsOptional, IsString, Min, MaxLength } from 'class-validator';

/** Same DTO for create and full-replace update (plan §4.19). */
export class CategoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nameAr!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nameEn!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  iconUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}
