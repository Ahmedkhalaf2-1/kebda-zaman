import { BadRequestException, Injectable } from '@nestjs/common';
import { RestaurantSettings } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateSettingsDto, WorkingHoursDayDto } from './dto/update-settings.dto';

/** Public-safe subset — business profile + operational info a customer app needs to display. */
export interface PublicSettingsResponseDto {
  restaurantNameAr: string;
  restaurantNameEn: string;
  logoUrl: string | null;
  phone: string;
  addressAr: string;
  addressEn: string;
  deliveryFee: number;
  taxRatePercent: number;
  minOrderAmount: number;
  workingHours: WorkingHoursDayDto[];
  timezone: string;
  acceptingOrders: boolean;
  closedMessageAr: string | null;
  closedMessageEn: string | null;
  isMaintenanceMode: boolean;
}

/** ADMIN-only: adds internal/operational fields not needed by a customer app. */
export interface AdminSettingsResponseDto extends PublicSettingsResponseDto {
  id: string;
  currency: string;
  updatedAt: string;
}

function toPublicSettingsResponse(settings: RestaurantSettings): PublicSettingsResponseDto {
  return {
    restaurantNameAr: settings.restaurantNameAr,
    restaurantNameEn: settings.restaurantNameEn,
    logoUrl: settings.logoUrl,
    phone: settings.phone,
    addressAr: settings.addressAr,
    addressEn: settings.addressEn,
    deliveryFee: settings.deliveryFee.toNumber(),
    taxRatePercent: settings.taxRatePercent.toNumber(),
    minOrderAmount: settings.minOrderAmount.toNumber(),
    workingHours: settings.workingHours as unknown as WorkingHoursDayDto[],
    timezone: settings.timezone,
    acceptingOrders: settings.acceptingOrders,
    closedMessageAr: settings.closedMessageAr,
    closedMessageEn: settings.closedMessageEn,
    isMaintenanceMode: settings.isMaintenanceMode,
  };
}

function toAdminSettingsResponse(settings: RestaurantSettings): AdminSettingsResponseDto {
  return {
    ...toPublicSettingsResponse(settings),
    id: settings.id,
    currency: settings.currency,
    updatedAt: settings.updatedAt.toISOString(),
  };
}

/** Every dayOfWeek 0-6 exactly once; openTime/closeTime required (and HH:MM-valid,
 * already checked by the DTO) exactly when isOpen is true, absent otherwise. */
function assertValidWorkingHours(days: WorkingHoursDayDto[]): void {
  const seen = new Set<number>();
  for (const day of days) {
    if (seen.has(day.dayOfWeek)) {
      throw new BadRequestException({
        message: `Duplicate dayOfWeek ${day.dayOfWeek} in workingHours`,
        code: 'INVALID_WORKING_HOURS',
      });
    }
    seen.add(day.dayOfWeek);

    if (day.isOpen && (!day.openTime || !day.closeTime)) {
      throw new BadRequestException({
        message: `openTime/closeTime are required when isOpen is true (dayOfWeek ${day.dayOfWeek})`,
        code: 'INVALID_WORKING_HOURS',
      });
    }
  }
  for (let d = 0; d <= 6; d += 1) {
    if (!seen.has(d)) {
      throw new BadRequestException({
        message: `workingHours is missing dayOfWeek ${d}`,
        code: 'INVALID_WORKING_HOURS',
      });
    }
  }
}

/** Closed days are stored with null times regardless of what was submitted — avoids stale/misleading data. */
function normalizeWorkingHours(days: WorkingHoursDayDto[]): WorkingHoursDayDto[] {
  return days.map((day) => ({
    dayOfWeek: day.dayOfWeek,
    isOpen: day.isOpen,
    openTime: day.isOpen ? (day.openTime ?? null) : null,
    closeTime: day.isOpen ? (day.closeTime ?? null) : null,
  }));
}

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Raw settings row (Decimal fields) for internal pricing use. */
  async getSettings(): Promise<RestaurantSettings> {
    return this.prisma.restaurantSettings.findFirstOrThrow({ where: { singleton: true } });
  }

  /** Public subset (plan §4.23, extended Phase 8): business profile, hours, acceptance state. */
  async getPublicSettings(): Promise<PublicSettingsResponseDto> {
    return toPublicSettingsResponse(await this.getSettings());
  }

  // ===========================================================================
  // Admin (plan §4.23)
  // ===========================================================================

  async getAdminSettings(): Promise<AdminSettingsResponseDto> {
    return toAdminSettingsResponse(await this.getSettings());
  }

  async updateSettings(dto: UpdateSettingsDto): Promise<AdminSettingsResponseDto> {
    assertValidWorkingHours(dto.workingHours);
    const workingHours = normalizeWorkingHours(dto.workingHours);

    const updated = await this.prisma.restaurantSettings.update({
      where: { singleton: true },
      data: {
        restaurantNameAr: dto.restaurantNameAr,
        restaurantNameEn: dto.restaurantNameEn,
        logoUrl: dto.logoUrl ?? null,
        phone: dto.phone,
        addressAr: dto.addressAr,
        addressEn: dto.addressEn,
        taxRatePercent: dto.taxRatePercent,
        deliveryFee: dto.deliveryFee,
        minOrderAmount: dto.minOrderAmount,
        currency: dto.currency,
        workingHours: workingHours as unknown as object,
        timezone: dto.timezone,
        isMaintenanceMode: dto.isMaintenanceMode,
        acceptingOrders: dto.acceptingOrders,
        closedMessageAr: dto.closedMessageAr ?? null,
        closedMessageEn: dto.closedMessageEn ?? null,
      },
    });
    return toAdminSettingsResponse(updated);
  }
}
