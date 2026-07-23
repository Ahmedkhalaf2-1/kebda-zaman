import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

export const FRONTEND_STATUSES = [
  'pending',
  'confirmed',
  'preparing',
  'outForDelivery',
  'delivered',
  'cancelled',
] as const;

export class ListOrdersDto {
  @IsOptional()
  @IsIn(FRONTEND_STATUSES)
  status?: (typeof FRONTEND_STATUSES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
