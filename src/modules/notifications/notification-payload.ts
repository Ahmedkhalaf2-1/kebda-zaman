import { randomUUID } from 'node:crypto';
import { DeliveryMethod, OrderStatus } from '@prisma/client';

/** The 14 types the Flutter `NotificationType` enum parses (audit §12). */
export const NOTIFICATION_TYPES = [
  'general',
  'promotion',
  'offer',
  'new_product',
  'category',
  'order_created',
  'order_confirmed',
  'order_preparing',
  'order_ready',
  'order_out_for_delivery',
  'order_delivered',
  'order_cancelled',
  'payment_success',
  'payment_failed',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * Mirrors the Flutter `AppNotificationPayload` model (plan §9.4 / audit §12)
 * field-for-field — the FCM `data` payload must use exactly these keys so
 * the existing client-side parser/deep-link navigation keep working
 * untouched.
 */
export interface AppNotificationPayload {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  route?: string;
  entityId?: string;
  /** Generic entity-kind tag (e.g. `"order"`) — lets the client tell what
   * `entityId` refers to without inferring it from `type`/`route`, so it can
   * invalidate any cached view of that entity, not just deep-link into one. */
  entityType?: string;
  /** Order-status pushes only: same value as `entityId`, exposed under its
   * own explicit key so the client never has to assume `entityId` means
   * "order id" for other notification types. */
  orderId?: string;
  imageUrl?: string;
  timestamp?: string;
}

/** FCM data payloads must be string-to-string maps. */
export function toFcmDataPayload(payload: AppNotificationPayload): Record<string, string> {
  const data: Record<string, string> = {
    id: payload.id,
    type: payload.type,
    title: payload.title,
    body: payload.body,
  };
  if (payload.route) data.route = payload.route;
  if (payload.entityId) data.entityId = payload.entityId;
  if (payload.entityType) data.entityType = payload.entityType;
  if (payload.orderId) data.orderId = payload.orderId;
  if (payload.imageUrl) data.imageUrl = payload.imageUrl;
  if (payload.timestamp) data.timestamp = payload.timestamp;
  return data;
}

type OrderStatusNotificationConfig = { type: NotificationType; title: string; body: string };

/**
 * DB OrderStatus -> notification content. Fix 12A split the state machine so
 * OUT_FOR_DELIVERY/DELIVERED are DELIVERY-only and READY_FOR_PICKUP/PICKED_UP
 * are PICKUP-only (OrdersService.getAllowedTransitions never lets one
 * delivery method reach the other method's statuses) — every DB status now
 * maps to exactly one piece of wording, so this is a single flat table
 * instead of a shared-map-plus-per-method-override.
 */
const ORDER_STATUS_NOTIFICATION: Record<OrderStatus, OrderStatusNotificationConfig> = {
  PENDING: { type: 'order_created', title: 'Order placed', body: 'Your order has been received.' },
  CONFIRMED: {
    type: 'order_confirmed',
    title: 'Order confirmed',
    body: 'Your order has been confirmed.',
  },
  PREPARING: {
    type: 'order_preparing',
    title: 'Order in progress',
    body: 'Your order is being prepared.',
  },
  OUT_FOR_DELIVERY: {
    type: 'order_out_for_delivery',
    title: 'Order out for delivery',
    body: 'Your order is on its way.',
  },
  READY_FOR_PICKUP: {
    type: 'order_ready',
    title: 'Order ready for pickup',
    body: 'Your order is ready to be collected.',
  },
  DELIVERED: {
    type: 'order_delivered',
    title: 'Order delivered',
    body: 'Your order has been delivered. Enjoy!',
  },
  PICKED_UP: {
    type: 'order_delivered',
    title: 'Order picked up',
    body: 'Your order has been picked up. Enjoy!',
  },
  CANCELLED: {
    type: 'order_cancelled',
    title: 'Order cancelled',
    body: 'Your order has been cancelled.',
  },
};

/** Defense in depth: OrdersService.getAllowedTransitions already makes these
 * combinations unreachable, but a notification must never describe a
 * DELIVERY order as ready-for-pickup/picked-up or a PICKUP order as
 * out-for-delivery/delivered even if a status were ever forced directly in
 * the DB. */
const DELIVERY_ONLY_STATUSES = new Set<OrderStatus>(['OUT_FOR_DELIVERY', 'DELIVERED']);
const PICKUP_ONLY_STATUSES = new Set<OrderStatus>(['READY_FOR_PICKUP', 'PICKED_UP']);

export function buildOrderStatusPayload(
  orderId: string,
  status: OrderStatus,
  deliveryMethod: DeliveryMethod,
): AppNotificationPayload | null {
  if (deliveryMethod === 'PICKUP' && DELIVERY_ONLY_STATUSES.has(status)) {
    return null;
  }
  if (deliveryMethod === 'DELIVERY' && PICKUP_ONLY_STATUSES.has(status)) {
    return null;
  }
  const config = ORDER_STATUS_NOTIFICATION[status];
  if (!config) {
    return null;
  }
  return {
    id: randomUUID(),
    type: config.type,
    title: config.title,
    body: config.body,
    route: `/orders/tracking/${orderId}`,
    entityId: orderId,
    entityType: 'order',
    orderId,
    timestamp: Date.now().toString(),
  };
}
