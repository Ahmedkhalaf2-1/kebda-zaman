import { AdminNotification } from '@prisma/client';

export interface AdminNotificationResponseDto {
  id: string;
  type: string;
  title: string;
  body: string;
  orderId: string | null;
  customerId: string | null;
  customerName: string | null;
  orderNumber: string | null;
  totalAmount: number | null;
  isRead: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toAdminNotificationResponse(
  notification: AdminNotification,
): AdminNotificationResponseDto {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    orderId: notification.orderId,
    customerId: notification.customerId,
    customerName: notification.customerName,
    orderNumber: notification.orderNumber,
    totalAmount: notification.totalAmount?.toNumber() ?? null,
    isRead: notification.isRead,
    createdAt: notification.createdAt.toISOString(),
    updatedAt: notification.updatedAt.toISOString(),
  };
}
