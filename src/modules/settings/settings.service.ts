import { Injectable } from '@nestjs/common';
import { RestaurantSettings } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';

export interface PublicSettingsResponseDto {
  deliveryFee: number;
  taxRatePercent: number;
  minOrderAmount: number;
  workingHours: unknown;
  isMaintenanceMode: boolean;
}

export interface AdminSettingsResponseDto extends PublicSettingsResponseDto {
  id: string;
  restaurantName: string;
  phone: string;
  addressText: string;
  currency: string;
  updatedAt: string;
}

function toAdminSettingsResponse(settings: RestaurantSettings): AdminSettingsResponseDto {
  return {
    id: settings.id,
    restaurantName: settings.restaurantName,
    phone: settings.phone,
    addressText: settings.addressText,
    deliveryFee: settings.deliveryFee.toNumber(),
    taxRatePercent: settings.taxRatePercent.toNumber(),
    minOrderAmount: settings.minOrderAmount.toNumber(),
    currency: settings.currency,
    workingHours: settings.workingHours,
    isMaintenanceMode: settings.isMaintenanceMode,
    updatedAt: settings.updatedAt.toISOString(),
  };
}

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Raw settings row (Decimal fields) for internal pricing use. */
  async getSettings(): Promise<RestaurantSettings> {
    return this.prisma.restaurantSettings.findFirstOrThrow({ where: { singleton: true } });
  }

  /** Public subset per plan §4.23: delivery fee, tax, min order, hours, maintenance. */
  async getPublicSettings(): Promise<PublicSettingsResponseDto> {
    const settings = await this.getSettings();
    return {
      deliveryFee: settings.deliveryFee.toNumber(),
      taxRatePercent: settings.taxRatePercent.toNumber(),
      minOrderAmount: settings.minOrderAmount.toNumber(),
      workingHours: settings.workingHours,
      isMaintenanceMode: settings.isMaintenanceMode,
    };
  }

  // ===========================================================================
  // Admin (plan §4.23)
  // ===========================================================================

  async getAdminSettings(): Promise<AdminSettingsResponseDto> {
    return toAdminSettingsResponse(await this.getSettings());
  }

  async updateSettings(dto: UpdateSettingsDto): Promise<AdminSettingsResponseDto> {
    const updated = await this.prisma.restaurantSettings.update({
      where: { singleton: true },
      data: {
        restaurantName: dto.restaurantName,
        phone: dto.phone,
        addressText: dto.addressText,
        taxRatePercent: dto.taxRatePercent,
        deliveryFee: dto.deliveryFee,
        minOrderAmount: dto.minOrderAmount,
        currency: dto.currency,
        workingHours: { open: dto.workingHours.open, close: dto.workingHours.close },
        isMaintenanceMode: dto.isMaintenanceMode,
      },
    });
    return toAdminSettingsResponse(updated);
  }
}
