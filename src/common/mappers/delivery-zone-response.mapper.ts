import { DeliveryZone } from '@prisma/client';

/** Public shape: what a customer needs to pick a zone at checkout. No isActive
 * (the public endpoint only ever lists active zones) and no timestamps. */
export interface DeliveryZoneResponseDto {
  id: string;
  nameAr: string;
  nameEn: string;
  deliveryFee: number;
  minimumOrder: number;
  sortOrder: number;
}

export function toDeliveryZoneResponse(zone: DeliveryZone): DeliveryZoneResponseDto {
  return {
    id: zone.id,
    nameAr: zone.nameAr,
    nameEn: zone.nameEn,
    deliveryFee: zone.deliveryFee.toNumber(),
    minimumOrder: zone.minimumOrder.toNumber(),
    sortOrder: zone.sortOrder,
  };
}

/** Admin view: adds isActive + audit timestamps, which the public endpoint never exposes. */
export interface AdminDeliveryZoneResponseDto extends DeliveryZoneResponseDto {
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toAdminDeliveryZoneResponse(zone: DeliveryZone): AdminDeliveryZoneResponseDto {
  return {
    ...toDeliveryZoneResponse(zone),
    isActive: zone.isActive,
    createdAt: zone.createdAt.toISOString(),
    updatedAt: zone.updatedAt.toISOString(),
  };
}
