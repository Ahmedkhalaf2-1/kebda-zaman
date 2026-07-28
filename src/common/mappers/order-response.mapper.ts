import {
  Order,
  OrderItem,
  OrderItemCustomization,
  OrderStatus,
  OrderStatusHistory,
  PaymentMethod,
  User,
} from '@prisma/client';
import { toUserResponse, UserResponseDto } from './user-response.mapper';

/**
 * Frontend enum casing (plan §3.5 / D2): DB is UPPER_SNAKE, Flutter's
 * `OrderStatus` enum is lowerCamel. `outForDelivery` is the only irregular one.
 */
const ORDER_STATUS_TO_FRONTEND: Record<OrderStatus, string> = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PREPARING: 'preparing',
  OUT_FOR_DELIVERY: 'outForDelivery',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
};

/** Reverse of the above, for accepting a frontend-form `?status=` filter. */
export const FRONTEND_STATUS_TO_ORDER_STATUS: Record<string, OrderStatus> = {
  pending: 'PENDING',
  confirmed: 'CONFIRMED',
  preparing: 'PREPARING',
  outForDelivery: 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
  cancelled: 'CANCELLED',
};

/**
 * `paymentMethod` is a free `String` on the Flutter side (plan §3.5, D3 —
 * exact values unconfirmed without access to the real frontend model).
 * Lowercased for consistency with the status-casing convention above;
 * revisit once the real model is available.
 */
export const PAYMENT_METHOD_TO_FRONTEND: Record<PaymentMethod, string> = {
  CASH: 'cash',
  CARD: 'card',
  WALLET: 'wallet',
};

export interface OrderItemMenuSnapshotDto {
  nameAr: string;
  nameEn: string;
  imageUrl: string | null;
}

export interface OrderItemCustomizationSnapshotDto {
  id: string;
  nameAr: string;
  nameEn: string;
  priceSnapshot: number;
}

/** Mirrors CartItem's response shape (plan §3.5) using the order's immutable
 * snapshots instead of a live catalog join — the whole point of a snapshot
 * is that it never changes when the catalog does. */
export interface OrderItemResponseDto {
  id: string;
  menuItem: OrderItemMenuSnapshotDto;
  selectedVariant: OrderItemCustomizationSnapshotDto | null;
  selectedAddons: OrderItemCustomizationSnapshotDto[];
  quantity: number;
  specialInstructions: string | null;
  unitPrice: number;
  totalPrice: number;
}

export type OrderItemWithCustomizations = OrderItem & {
  customizations: OrderItemCustomization[];
};

export function toOrderItemResponse(item: OrderItemWithCustomizations): OrderItemResponseDto {
  const variant = item.customizations.find((c) => c.kind === 'VARIANT') ?? null;
  const addons = item.customizations.filter((c) => c.kind === 'ADDON');

  return {
    id: item.id,
    menuItem: {
      nameAr: item.nameArSnapshot,
      nameEn: item.nameEnSnapshot,
      imageUrl: item.imageUrlSnapshot,
    },
    selectedVariant: variant
      ? {
          id: variant.id,
          nameAr: variant.nameArSnapshot,
          nameEn: variant.nameEnSnapshot,
          priceSnapshot: variant.priceSnapshot.toNumber(),
        }
      : null,
    selectedAddons: addons.map((addon) => ({
      id: addon.id,
      nameAr: addon.nameArSnapshot,
      nameEn: addon.nameEnSnapshot,
      priceSnapshot: addon.priceSnapshot.toNumber(),
    })),
    quantity: item.quantity,
    specialInstructions: item.specialInstructions,
    unitPrice: item.unitPrice.toNumber(),
    totalPrice: item.lineTotal.toNumber(),
  };
}

export function toFrontendStatus(status: OrderStatus): string {
  return ORDER_STATUS_TO_FRONTEND[status];
}

export interface OrderStatusHistoryEntryDto {
  status: string;
  note: string | null;
  changedAt: string;
}

export function toStatusHistoryEntry(entry: OrderStatusHistory): OrderStatusHistoryEntryDto {
  return {
    status: ORDER_STATUS_TO_FRONTEND[entry.toStatus],
    note: entry.note,
    changedAt: entry.createdAt.toISOString(),
  };
}

/** Present only when a loyalty reward was redeemed atomically as part of this checkout — see OrdersService.checkout. */
export interface OrderLoyaltyRedemptionDto {
  rewardId: string;
  rewardName: string;
  pointsRedeemed: number;
}

export interface OrderResponseDto {
  id: string;
  orderNumber: string;
  userId: string;
  user: UserResponseDto;
  items: OrderItemResponseDto[];
  status: string;
  deliveryAddress: unknown;
  paymentMethod: string;
  subtotal: number;
  deliveryFee: number;
  tax: number;
  discount: number;
  totalAmount: number;
  createdAt: string;
  estimatedDeliveryTime: string | null;
  /** `null` when no loyalty reward was redeemed for this order (the normal case) — additive field, safe to ignore. */
  loyaltyRedemption: OrderLoyaltyRedemptionDto | null;
}

export type OrderWithRelations = Order & {
  user: User;
  items: OrderItemWithCustomizations[];
};

export function toOrderResponse(
  order: OrderWithRelations,
  loyaltyRedemption: OrderLoyaltyRedemptionDto | null = null,
): OrderResponseDto {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    userId: order.userId,
    user: toUserResponse(order.user),
    items: order.items.map(toOrderItemResponse),
    status: ORDER_STATUS_TO_FRONTEND[order.status],
    deliveryAddress: order.deliveryAddressJson,
    paymentMethod: PAYMENT_METHOD_TO_FRONTEND[order.paymentMethod],
    subtotal: order.subtotal.toNumber(),
    deliveryFee: order.deliveryFee.toNumber(),
    tax: order.tax.toNumber(),
    discount: order.discount.toNumber(),
    totalAmount: order.totalAmount.toNumber(),
    createdAt: order.createdAt.toISOString(),
    estimatedDeliveryTime: order.estimatedDeliveryTime?.toISOString() ?? null,
    loyaltyRedemption,
  };
}

export interface OrderStatusResponseDto {
  status: string;
  statusHistory: OrderStatusHistoryEntryDto[];
  estimatedDeliveryTime: string | null;
}
