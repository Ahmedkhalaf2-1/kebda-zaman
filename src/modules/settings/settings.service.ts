import { Injectable } from '@nestjs/common';
import { RestaurantSettings } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface PublicSettingsResponseDto {
  deliveryFee: number;
  taxRatePercent: number;
  minOrderAmount: number;
  workingHours: unknown;
  isMaintenanceMode: boolean;
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
}
