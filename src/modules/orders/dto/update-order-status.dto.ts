import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { FRONTEND_STATUSES } from './list-orders.dto';

/** Same lowerCamel status form the rest of the API emits/accepts — one canonical wire format. */
export class UpdateOrderStatusDto {
  @IsIn(FRONTEND_STATUSES)
  status!: (typeof FRONTEND_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
