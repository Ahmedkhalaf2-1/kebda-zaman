import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ListAdminNotificationsDto } from './dto/list-admin-notifications.dto';
import {
  AdminNotificationResponseDto,
  toAdminNotificationResponse,
} from './admin-notification-response.mapper';

export const ADMIN_NOTIFICATION_TYPE = {
  NEW_ORDER: 'NEW_ORDER',
} as const;

export interface NewOrderNotificationParams {
  orderId: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  totalAmount: Prisma.Decimal;
}

@Injectable()
export class AdminNotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Called from inside `OrdersService.checkout`'s own DB transaction (`tx` is
   * that transaction's client, never `this.prisma`) so the notification row
   * is committed atomically with the order itself — if checkout rolls back,
   * no orphaned notification is left behind, and there is no separate
   * post-commit step that could fail independently of order creation.
   */
  async createForNewOrder(
    tx: Prisma.TransactionClient,
    params: NewOrderNotificationParams,
  ): Promise<{ id: string }> {
    return tx.adminNotification.create({
      data: {
        type: ADMIN_NOTIFICATION_TYPE.NEW_ORDER,
        title: 'New order received',
        body: `${params.customerName} placed order ${params.orderNumber}`,
        orderId: params.orderId,
        customerId: params.customerId,
        customerName: params.customerName,
        orderNumber: params.orderNumber,
        totalAmount: params.totalAmount,
      },
      select: { id: true },
    });
  }

  async list(query: ListAdminNotificationsDto): Promise<AdminNotificationResponseDto[]> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const notifications = await this.prisma.adminNotification.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return notifications.map(toAdminNotificationResponse);
  }

  async unreadCount(): Promise<{ count: number }> {
    const count = await this.prisma.adminNotification.count({ where: { isRead: false } });
    return { count };
  }

  async markAsRead(id: string): Promise<AdminNotificationResponseDto> {
    const existing = await this.prisma.adminNotification.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({
        message: 'Notification not found',
        code: 'NOTIFICATION_NOT_FOUND',
      });
    }
    const updated = await this.prisma.adminNotification.update({
      where: { id },
      data: { isRead: true },
    });
    return toAdminNotificationResponse(updated);
  }

  async markAllAsRead(): Promise<{ updated: number }> {
    const result = await this.prisma.adminNotification.updateMany({
      where: { isRead: false },
      data: { isRead: true },
    });
    return { updated: result.count };
  }

  async deleteAll(): Promise<void> {
    await this.prisma.adminNotification.deleteMany({});
  }
}
