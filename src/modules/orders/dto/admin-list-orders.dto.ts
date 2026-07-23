import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { FRONTEND_STATUSES } from './list-orders.dto';

export class AdminListOrdersDto {
  @IsOptional()
  @IsIn(FRONTEND_STATUSES)
  status?: (typeof FRONTEND_STATUSES)[number];

  // Free-text search across orderNumber and the customer's name/email.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

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
