import { randomUUID } from 'node:crypto';
import { OrderStatus } from '@prisma/client';

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

/**
 * DB OrderStatus -> notification content. READY has no DB status (plan
 * §7.1 D2a Option A — deferred, admin-only sub-state) so it's not mapped
 * here; a future Phase 7 admin flow can send `order_ready` directly without
 * needing a matching OrderStatus value.
 */
const ORDER_STATUS_NOTIFICATION: Partial<
  Record<OrderStatus, { type: NotificationType; title: string; body: string }>
> = {
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
  DELIVERED: {
    type: 'order_delivered',
    title: 'Order delivered',
    body: 'Your order has been delivered. Enjoy!',
  },
  CANCELLED: {
    type: 'order_cancelled',
    title: 'Order cancelled',
    body: 'Your order has been cancelled.',
  },
};

export function buildOrderStatusPayload(
  orderId: string,
  status: OrderStatus,
): AppNotificationPayload | null {
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
