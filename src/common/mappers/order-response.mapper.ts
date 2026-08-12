import {
  DeliveryMethod,
  Order,
  OrderItem,
  OrderItemCustomization,
  OrderStatus,
  OrderStatusHistory,
  Payment,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  User,
} from '@prisma/client';
import { toUserResponse, UserResponseDto } from './user-response.mapper';

/**
 * Frontend enum casing (plan §3.5 / D2): DB is UPPER_SNAKE, Flutter's
 * `OrderStatus` enum is lowerCamel. `outForDelivery` is the only irregular
 * one. READY_FOR_PICKUP/PICKED_UP (Fix 12A) are the pickup-specific
 * equivalents of OUT_FOR_DELIVERY/DELIVERED — never reachable by a DELIVERY
 * order, so there is no casing ambiguity between the two lifecycles.
 */
const ORDER_STATUS_TO_FRONTEND: Record<OrderStatus, string> = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PREPARING: 'preparing',
  OUT_FOR_DELIVERY: 'outForDelivery',
  READY_FOR_PICKUP: 'readyForPickup',
  DELIVERED: 'delivered',
  PICKED_UP: 'pickedUp',
  CANCELLED: 'cancelled',
};

/** Reverse of the above, for accepting a frontend-form `?status=` filter. */
export const FRONTEND_STATUS_TO_ORDER_STATUS: Record<string, OrderStatus> = {
  pending: 'PENDING',
  confirmed: 'CONFIRMED',
  preparing: 'PREPARING',
  outForDelivery: 'OUT_FOR_DELIVERY',
  readyForPickup: 'READY_FOR_PICKUP',
  delivered: 'DELIVERED',
  pickedUp: 'PICKED_UP',
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
  /** Soft reference (plain UUID, not an FK) to the live MenuItemVariant/
   * MenuItemAddon this snapshot was taken from — null if the original
   * variant/addon row is unknown (pre-existing rows created before this
   * field was tracked). Lets a client re-look-up the live item for a
   * reorder flow; never re-derive display data from it, the snapshot
   * fields above remain the source of truth for what was actually ordered. */
  refId: string | null;
  nameAr: string;
  nameEn: string;
  priceSnapshot: number;
}

/** Mirrors CartItem's response shape (plan §3.5) using the order's immutable
 * snapshots instead of a live catalog join — the whole point of a snapshot
 * is that it never changes when the catalog does. */
export interface OrderItemResponseDto {
  id: string;
  /** Soft reference (plain UUID, not an FK) to the live MenuItem this
   * snapshot was taken from — null if the item was deleted since, or for
   * historical rows predating this field. Lets a client re-look-up the
   * live item (price/availability) for a reorder flow; the `menuItem`
   * snapshot below remains the source of truth for what was actually
   * ordered. */
  menuItemId: string | null;
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
    menuItemId: item.menuItemId,
    menuItem: {
      nameAr: item.nameArSnapshot,
      nameEn: item.nameEnSnapshot,
      imageUrl: item.imageUrlSnapshot,
    },
    selectedVariant: variant
      ? {
          id: variant.id,
          refId: variant.refId,
          nameAr: variant.nameArSnapshot,
          nameEn: variant.nameEnSnapshot,
          priceSnapshot: variant.priceSnapshot.toNumber(),
        }
      : null,
    selectedAddons: addons.map((addon) => ({
      id: addon.id,
      refId: addon.refId,
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

/** DEPRECATED — present only for DELIVERY orders placed under the old
 * zone-based system, before the distance-pricing migration; always null on
 * every order created since. Kept only so those historical orders keep
 * reading back correctly. Built entirely from the order's own snapshot
 * columns, never a live DeliveryZone join. */
export interface OrderDeliveryZoneDto {
  id: string;
  nameAr: string;
  nameEn: string;
}

/** Present only for DELIVERY orders placed after the distance-pricing
 * migration — null for PICKUP and for older zone-based orders. Built
 * entirely from the order's own snapshot columns, never a live
 * DeliveryDistanceTier join — a tier edited/deactivated after this order
 * shipped must not change what this order reports. */
export interface OrderDeliveryTierDto {
  id: string;
  minDistanceKm: string;
  maxDistanceKm: string;
}

/** Order's immutable delivery-address snapshot (plan VO2.3). Built entirely
 * from `deliveryAddressJson` at read time — never re-derived, never joined
 * against the customer's live saved Address, so later edits/deletes of that
 * Address never change what an existing order reports. `latitude`/
 * `longitude` are always present in the response (nullable) even for orders
 * placed before this phase, whose stored JSON never had those keys. */
export interface OrderDeliveryAddressSnapshotDto {
  latitude: number | null;
  longitude: number | null;
  [key: string]: unknown;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function toDeliveryAddressSnapshot(json: Prisma.JsonValue): OrderDeliveryAddressSnapshotDto {
  const raw: Record<string, unknown> =
    json !== null && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};
  // PICKUP's `{ type: 'PICKUP' }` snapshot is untouched by this feature
  // (plan VO2.3 §8) — no latitude/longitude keys are added to it.
  if (raw.type === 'PICKUP') {
    return raw as OrderDeliveryAddressSnapshotDto;
  }
  return {
    ...raw,
    latitude: isFiniteNumber(raw.latitude) ? raw.latitude : null,
    longitude: isFiniteNumber(raw.longitude) ? raw.longitude : null,
  };
}

export interface OrderResponseDto {
  id: string;
  orderNumber: string;
  userId: string;
  user: UserResponseDto;
  items: OrderItemResponseDto[];
  status: string;
  deliveryAddress: OrderDeliveryAddressSnapshotDto;
  deliveryMethod: DeliveryMethod;
  paymentMethod: string;
  paymentStatus: PaymentStatus;
  subtotal: number;
  deliveryFee: number;
  tax: number;
  discount: number;
  totalAmount: number;
  createdAt: string;
  estimatedDeliveryTime: string | null;
  /** `null` when no loyalty reward was redeemed for this order (the normal case) — additive field, safe to ignore. */
  loyaltyRedemption: OrderLoyaltyRedemptionDto | null;
  /** DEPRECATED — `null` for every order placed after the distance-pricing
   * migration (and for PICKUP). See OrderDeliveryZoneDto. */
  deliveryZone: OrderDeliveryZoneDto | null;
  /** `null` for PICKUP orders and for orders placed before the
   * distance-pricing migration. */
  deliveryDistanceMeters: number | null;
  /** Derived from `deliveryDistanceMeters`, 2 decimal places. `null` when that is `null`. */
  deliveryDistanceKm: string | null;
  deliveryDurationSeconds: number | null;
  /** `null` for PICKUP orders and for orders placed before the distance-pricing migration. */
  deliveryTier: OrderDeliveryTierDto | null;
  /** When the current CARD payment was authorized (Moyasar hold created) — `null` for CASH/WALLET orders and before authorization completes. */
  paymentAuthorizedAt: string | null;
}

export type OrderWithRelations = Order & {
  user: User;
  items: OrderItemWithCustomizations[];
  /** Latest Payment row only (`orderInclude` takes 1, newest first) — enough to read `authorizedAt`. */
  payments?: Payment[];
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
    deliveryAddress: toDeliveryAddressSnapshot(order.deliveryAddressJson),
    deliveryMethod: order.deliveryMethod,
    paymentMethod: PAYMENT_METHOD_TO_FRONTEND[order.paymentMethod],
    paymentStatus: order.paymentStatus,
    subtotal: order.subtotal.toNumber(),
    deliveryFee: order.deliveryFee.toNumber(),
    tax: order.tax.toNumber(),
    discount: order.discount.toNumber(),
    totalAmount: order.totalAmount.toNumber(),
    createdAt: order.createdAt.toISOString(),
    estimatedDeliveryTime: order.estimatedDeliveryTime?.toISOString() ?? null,
    loyaltyRedemption,
    deliveryZone: order.deliveryZoneId
      ? {
          id: order.deliveryZoneId,
          nameAr: order.deliveryZoneNameArSnapshot ?? '',
          nameEn: order.deliveryZoneNameEnSnapshot ?? '',
        }
      : null,
    deliveryDistanceMeters: order.deliveryDistanceMeters,
    deliveryDistanceKm:
      order.deliveryDistanceMeters !== null
        ? (order.deliveryDistanceMeters / 1000).toFixed(2)
        : null,
    deliveryDurationSeconds: order.deliveryDurationSeconds,
    deliveryTier:
      order.deliveryTierId && order.deliveryTierMinKmSnapshot && order.deliveryTierMaxKmSnapshot
        ? {
            id: order.deliveryTierId,
            minDistanceKm: order.deliveryTierMinKmSnapshot.toFixed(2),
            maxDistanceKm: order.deliveryTierMaxKmSnapshot.toFixed(2),
          }
        : null,
    paymentAuthorizedAt: order.payments?.[0]?.authorizedAt?.toISOString() ?? null,
  };
}

/**
 * Admin-only visibility nudge (approved decision — no auto-void/auto-cancel):
 * an order still sitting AUTHORIZED past this many hours gets a flag on the
 * admin order list/detail so staff can act manually. Well inside Moyasar's
 * ~14-day Mada authorization window, just an early operational signal.
 */
export const AUTHORIZATION_AGING_THRESHOLD_HOURS = 24;

export interface AdminOrderResponseDto extends OrderResponseDto {
  /** true only when paymentStatus is still AUTHORIZED and it's been longer than AUTHORIZATION_AGING_THRESHOLD_HOURS. */
  authorizationAgingWarning: boolean;
}

export function toAdminOrderResponse(order: OrderWithRelations): AdminOrderResponseDto {
  const base = toOrderResponse(order);
  const authorizedAt = order.payments?.[0]?.authorizedAt ?? null;
  const ageHours = authorizedAt ? (Date.now() - authorizedAt.getTime()) / (1000 * 60 * 60) : 0;
  return {
    ...base,
    authorizationAgingWarning:
      base.paymentStatus === 'AUTHORIZED' && ageHours > AUTHORIZATION_AGING_THRESHOLD_HOURS,
  };
}

export interface OrderStatusResponseDto {
  status: string;
  statusHistory: OrderStatusHistoryEntryDto[];
  estimatedDeliveryTime: string | null;
}
