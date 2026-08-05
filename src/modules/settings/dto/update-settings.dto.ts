import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** One day of the weekly operating-hours array. Cross-field rule ("openTime/
 * closeTime required when isOpen") is enforced in SettingsService, matching
 * this codebase's convention of DTO-level shape + service-level business
 * rules (see CheckoutDto.deliveryAddress). Overnight ranges (e.g. 18:00 ->
 * 02:00) are valid — no open < close ordering is enforced here. */
export class WorkingHoursDayDto {
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @IsBoolean()
  isOpen!: boolean;

  @IsOptional()
  @IsString()
  @Matches(HH_MM, { message: 'openTime must be HH:MM (24h)' })
  openTime?: string | null;

  @IsOptional()
  @IsString()
  @Matches(HH_MM, { message: 'closeTime must be HH:MM (24h)' })
  closeTime?: string | null;
}

/** Full replace of the RestaurantSettings singleton (plan §4.23, extended Phase 8). */
export class UpdateSettingsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  restaurantNameAr!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  restaurantNameEn!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  logoUrl?: string | null;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  phone!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  addressAr!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  addressEn!: string;

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

  /** Exactly 7 entries, one per dayOfWeek (0-6), each unique — validated in SettingsService. */
  @ArrayMinSize(7)
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => WorkingHoursDayDto)
  workingHours!: WorkingHoursDayDto[];

  /** IANA timezone the working-hours times are expressed in (never server-local). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  timezone!: string;

  @IsBoolean()
  isMaintenanceMode!: boolean;

  /** Manual checkout gate — see RESTAURANT_NOT_ACCEPTING_ORDERS in checkout. */
  @IsBoolean()
  acceptingOrders!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  closedMessageAr?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  closedMessageEn?: string | null;

  /** Authoritative origin for every Google Routes distance calculation
   * (distance-based delivery pricing) — never hardcoded in a service. */
  @IsNumber()
  @Min(-90)
  @Max(90)
  restaurantLatitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  restaurantLongitude!: number;
}
