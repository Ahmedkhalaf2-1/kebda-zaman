import { DeliveryMethod, Order, Prisma, User } from '@prisma/client';
import { PAYMENT_METHOD_TO_FRONTEND, toFrontendStatus } from './order-response.mapper';

const DELIVERY_METHOD_TO_FRONTEND: Record<DeliveryMethod, string> = {
  DELIVERY: 'delivery',
  PICKUP: 'pickup',
};

export interface CustomerOrderStats {
  orderCount: number;
  totalSpent: Prisma.Decimal;
}

export interface CustomerListItemDto {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  isGuest: boolean;
  isActive: boolean;
  createdAt: string;
  orderCount: number;
  totalSpent: number;
}

export function toCustomerListItem(user: User, stats?: CustomerOrderStats): CustomerListItemDto {
  return {
    id: user.id,
    name: user.fullName,
    email: user.email,
    phone: user.phone,
    isGuest: user.isGuest,
    isActive: user.deletedAt === null,
    createdAt: user.createdAt.toISOString(),
    orderCount: stats?.orderCount ?? 0,
    totalSpent: (stats?.totalSpent ?? new Prisma.Decimal(0)).toNumber(),
  };
}

type RecentOrderRow = Pick<
  Order,
  'id' | 'orderNumber' | 'status' | 'totalAmount' | 'paymentMethod' | 'deliveryMethod' | 'createdAt'
>;

export interface CustomerRecentOrderDto {
  id: string;
  orderNumber: string;
  status: string;
  totalAmount: number;
  paymentMethod: string;
  fulfillmentType: string;
  createdAt: string;
}

export function toCustomerRecentOrder(order: RecentOrderRow): CustomerRecentOrderDto {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: toFrontendStatus(order.status),
    totalAmount: order.totalAmount.toNumber(),
    paymentMethod: PAYMENT_METHOD_TO_FRONTEND[order.paymentMethod],
    fulfillmentType: DELIVERY_METHOD_TO_FRONTEND[order.deliveryMethod],
    createdAt: order.createdAt.toISOString(),
  };
}

export interface CustomerDetailDto extends CustomerListItemDto {
  recentOrders: CustomerRecentOrderDto[];
}

export function toCustomerDetail(
  user: User,
  stats: CustomerOrderStats | undefined,
  recentOrders: RecentOrderRow[],
): CustomerDetailDto {
  return {
    ...toCustomerListItem(user, stats),
    recentOrders: recentOrders.map(toCustomerRecentOrder),
  };
}
