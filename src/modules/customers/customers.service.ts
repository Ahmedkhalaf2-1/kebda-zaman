import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CustomerDetailDto,
  CustomerListItemDto,
  CustomerOrderStats,
  toCustomerDetail,
  toCustomerListItem,
} from '../../common/mappers/customer-response.mapper';
import { ListCustomersDto } from './dto/list-customers.dto';
import { UpdateCustomerStatusDto } from './dto/update-customer-status.dto';

const RECENT_ORDERS_LIMIT = 10;

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListCustomersDto): Promise<CustomerListItemDto[]> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const customers = await this.prisma.user.findMany({
      where: {
        role: UserRole.CUSTOMER,
        ...(query.isActive === undefined
          ? {}
          : query.isActive
            ? { deletedAt: null }
            : { deletedAt: { not: null } }),
        ...(query.q
          ? {
              OR: [
                { fullName: { contains: query.q, mode: 'insensitive' as const } },
                { email: { contains: query.q, mode: 'insensitive' as const } },
                { phone: { contains: query.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const stats = await this.orderStatsByUser(customers.map((c) => c.id));
    return customers.map((c) => toCustomerListItem(c, stats.get(c.id)));
  }

  async getById(id: string): Promise<CustomerDetailDto> {
    const customer = await this.findCustomerOrThrow(id);
    const stats = await this.orderStatsByUser([id]);
    const recentOrders = await this.prisma.order.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      take: RECENT_ORDERS_LIMIT,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        totalAmount: true,
        paymentMethod: true,
        deliveryMethod: true,
        createdAt: true,
      },
    });
    return toCustomerDetail(customer, stats.get(id), recentOrders);
  }

  async updateStatus(id: string, dto: UpdateCustomerStatusDto): Promise<CustomerDetailDto> {
    await this.findCustomerOrThrow(id);
    await this.prisma.user.update({
      where: { id },
      data: { deletedAt: dto.isActive ? null : new Date() },
    });
    return this.getById(id);
  }

  private async findCustomerOrThrow(id: string) {
    const customer = await this.prisma.user.findFirst({
      where: { id, role: UserRole.CUSTOMER },
    });
    if (!customer) {
      throw new NotFoundException({ message: 'Customer not found', code: 'CUSTOMER_NOT_FOUND' });
    }
    return customer;
  }

  /** Batched per-customer order stats: count of all orders, spend from
   * completed orders only — DELIVERED (DELIVERY) or PICKED_UP (PICKUP),
   * the two terminal-success statuses (Fix 12A). */
  private async orderStatsByUser(userIds: string[]): Promise<Map<string, CustomerOrderStats>> {
    const map = new Map<string, CustomerOrderStats>();
    if (userIds.length === 0) {
      return map;
    }
    for (const id of userIds) {
      map.set(id, { orderCount: 0, totalSpent: new Prisma.Decimal(0) });
    }

    const [counts, sums] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds } },
        _count: { _all: true },
      }),
      this.prisma.order.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, status: { in: ['DELIVERED', 'PICKED_UP'] } },
        _sum: { totalAmount: true },
      }),
    ]);

    for (const row of counts) {
      map.set(row.userId, { ...map.get(row.userId)!, orderCount: row._count._all });
    }
    for (const row of sums) {
      map.set(row.userId, {
        ...map.get(row.userId)!,
        totalSpent: row._sum.totalAmount ?? new Prisma.Decimal(0),
      });
    }
    return map;
  }
}
