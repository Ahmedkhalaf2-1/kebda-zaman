import { Injectable, NotFoundException } from '@nestjs/common';
import { DeliveryZone } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminDeliveryZoneResponseDto,
  DeliveryZoneResponseDto,
  toAdminDeliveryZoneResponse,
  toDeliveryZoneResponse,
} from '../../common/mappers/delivery-zone-response.mapper';
import { DeliveryZoneDto } from './dto/delivery-zone.dto';

@Injectable()
export class DeliveryZonesService {
  constructor(private readonly prisma: PrismaService) {}

  async adminList(): Promise<AdminDeliveryZoneResponseDto[]> {
    const zones = await this.prisma.deliveryZone.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return zones.map(toAdminDeliveryZoneResponse);
  }

  /** Public catalog: active zones only, sorted for stable display order. */
  async listActive(): Promise<DeliveryZoneResponseDto[]> {
    const zones = await this.prisma.deliveryZone.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return zones.map(toDeliveryZoneResponse);
  }

  /** Used by OrdersService at checkout — the only authoritative source for a DELIVERY order's fee/minimum. */
  async findActiveById(id: string): Promise<DeliveryZone | null> {
    return this.prisma.deliveryZone.findFirst({ where: { id, isActive: true, deletedAt: null } });
  }

  async create(dto: DeliveryZoneDto): Promise<AdminDeliveryZoneResponseDto> {
    const zone = await this.prisma.deliveryZone.create({
      data: {
        nameAr: dto.nameAr,
        nameEn: dto.nameEn,
        deliveryFee: dto.deliveryFee,
        minimumOrder: dto.minimumOrder,
        isActive: dto.isActive ?? true,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
    return toAdminDeliveryZoneResponse(zone);
  }

  async update(id: string, dto: DeliveryZoneDto): Promise<AdminDeliveryZoneResponseDto> {
    const existing = await this.findOrThrow(id);
    const updated = await this.prisma.deliveryZone.update({
      where: { id: existing.id },
      data: {
        nameAr: dto.nameAr,
        nameEn: dto.nameEn,
        deliveryFee: dto.deliveryFee,
        minimumOrder: dto.minimumOrder,
        isActive: dto.isActive ?? existing.isActive,
        sortOrder: dto.sortOrder ?? existing.sortOrder,
      },
    });
    return toAdminDeliveryZoneResponse(updated);
  }

  /** Soft delete (mirrors Category/PromoCode) — orders keep their own name/fee
   * snapshot plus a SetNull FK, so history stays valid regardless. */
  async remove(id: string): Promise<void> {
    const existing = await this.findOrThrow(id);
    await this.prisma.deliveryZone.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  private async findOrThrow(id: string): Promise<DeliveryZone> {
    const zone = await this.prisma.deliveryZone.findFirst({ where: { id, deletedAt: null } });
    if (!zone) {
      throw new NotFoundException({ message: 'Delivery zone not found', code: 'DELIVERY_ZONE_NOT_FOUND' });
    }
    return zone;
  }
}
