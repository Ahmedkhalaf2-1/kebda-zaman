import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class WorkingHoursDto {
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'open must be HH:MM (24h)' })
  open!: string;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'close must be HH:MM (24h)' })
  close!: string;
}

/** Full replace of the RestaurantSettings singleton (plan §4.23). */
export class UpdateSettingsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  restaurantName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  phone!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  addressText!: string;

  @IsNumber()
  @Min(0)
  @Max(100)
  taxRatePercent!: number;

  @IsNumber()
  @Min(0)
  deliveryFee!: number;

  @IsNumber()
  @Min(0)
  minOrderAmount!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  currency!: string;

  @ValidateNested()
  @Type(() => WorkingHoursDto)
  workingHours!: WorkingHoursDto;

  @IsBoolean()
  isMaintenanceMode!: boolean;
}
