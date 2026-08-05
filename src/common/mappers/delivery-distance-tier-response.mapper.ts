import { DeliveryDistanceTier } from '@prisma/client';

export interface DeliveryDistanceTierResponseDto {
  id: string;
  minDistanceKm: string;
  maxDistanceKm: string;
  deliveryFee: string;
  minimumOrder: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export function toDeliveryDistanceTierResponse(
  tier: DeliveryDistanceTier,
): DeliveryDistanceTierResponseDto {
  return {
    id: tier.id,
    minDistanceKm: tier.minDistanceKm.toFixed(2),
    maxDistanceKm: tier.maxDistanceKm.toFixed(2),
    deliveryFee: tier.deliveryFee.toFixed(2),
    minimumOrder: tier.minimumOrder.toFixed(2),
    isActive: tier.isActive,
    sortOrder: tier.sortOrder,
    createdAt: tier.createdAt.toISOString(),
    updatedAt: tier.updatedAt.toISOString(),
  };
}
