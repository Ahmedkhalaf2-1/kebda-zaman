import { DeliveryMethod, Order, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import {
  OrderItemResponseDto,
  OrderItemWithCustomizations,
  toOrderItemResponse,
} from './order-response.mapper';

const ORDER_STATUS_TO_FRONTEND: Record<string, string> = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PREPARING: 'preparing',
  OUT_FOR_DELIVERY: 'outForDelivery',
  READY_FOR_PICKUP: 'readyForPickup',
  DELIVERED: 'delivered',
  PICKED_UP: 'pickedUp',
  CANCELLED: 'cancelled',
};

const PAYMENT_METHOD_TO_FRONTEND: Record<PaymentMethod, string> = {
  CASH: 'cash',
  CARD: 'card',
  WALLET: 'wallet',
};

function toDeliveryAddressSnapshot(json: Prisma.JsonValue): Record<string, unknown> {
  return json !== null && typeof json === 'object' && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : {};
}

/** Read-only "delivery ticket" for the DRIVER role — deliberately excludes every
 * field a driver has no legitimate reason to see or change: pricing breakdown
 * beyond the total, promo/loyalty details, payment-provider internals, the
 * customer's email, and anything admin-only (authorizationAgingWarning, etc.). */
export interface DriverOrderResponseDto {
  id: string;
  orderNumber: string;
  status: string;
  items: OrderItemResponseDto[];
  deliveryAddress: Record<string, unknown>;
  deliveryMethod: DeliveryMethod;
  /** Customer's name — always present. `customerPhone` is stripped to `null` for
   * completed-order history (toDriverOrderHistoryResponse) — a driver has no
   * ongoing reason to contact a customer after the delivery is done. */
  customerName: string;
  customerPhone: string | null;
  paymentMethod: string;
  paymentStatus: PaymentStatus;
  /** What the driver must physically collect on delivery — the order total for
   * an unpaid CASH order, 0 for everything already paid/captured (CARD/WALLET,
   * or a CASH order already settled). Never a signal to mark payment paid. */
  amountToCollect: number;
  totalAmount: number;
  createdAt: string;
  /** Phase 2 live tracking: the identifier the driver's app must echo back on
   * every `PUT /driver/orders/:id/location` call for this order
   * (`Order.driverAssignmentVersion`). Changes only when this order's driver
   * assignment actually changes (assign/reassign/unassign) — a stale value
   * is rejected with 409 ASSIGNMENT_VERSION_MISMATCH, so the app should
   * always use the value from its most recent read of this order. */
  assignmentVersion: number;
}

export type DriverOrderWithRelations = Order & {
  user: { fullName: string; phone: string | null };
  items: OrderItemWithCustomizations[];
};

function computeAmountToCollect(order: DriverOrderWithRelations): number {
  const alreadySettled = order.paymentStatus === 'PAID' || order.paymentStatus === 'CAPTURED';
  return order.paymentMethod === 'CASH' && !alreadySettled ? order.totalAmount.toNumber() : 0;
}

export function toDriverOrderResponse(order: DriverOrderWithRelations): DriverOrderResponseDto {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: ORDER_STATUS_TO_FRONTEND[order.status],
    items: order.items.map(toOrderItemResponse),
    deliveryAddress: toDeliveryAddressSnapshot(order.deliveryAddressJson),
    deliveryMethod: order.deliveryMethod,
    customerName: order.user.fullName,
    customerPhone: order.user.phone,
    paymentMethod: PAYMENT_METHOD_TO_FRONTEND[order.paymentMethod],
    paymentStatus: order.paymentStatus,
    amountToCollect: computeAmountToCollect(order),
    totalAmount: order.totalAmount.toNumber(),
    createdAt: order.createdAt.toISOString(),
    assignmentVersion: order.driverAssignmentVersion,
  };
}

/** Completed-delivery history view — same shape, minus the customer's phone
 * number (task requirement: minimize customer info once the delivery is done). */
export function toDriverOrderHistoryResponse(
  order: DriverOrderWithRelations,
): DriverOrderResponseDto {
  return { ...toDriverOrderResponse(order), customerPhone: null };
}
