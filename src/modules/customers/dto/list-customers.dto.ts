import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListCustomersDto {
  // Free-text search across name/email/phone.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  // Explicit string->boolean mapping — class-transformer's implicit `Boolean(value)`
  // conversion would otherwise turn the string "false" into `true`.
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
