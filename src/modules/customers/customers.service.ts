import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

export interface CustomerResetPreviewDto {
  loyaltyAccounts: number;
  pointsCleared: number;
  transactions: number;
  reviews: number;
  feedback: number;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

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

  /** Counts for the admin "wipe customers" confirmation dialog — no changes
   * made. Scoped to CUSTOMER users only (never STAFF/ADMIN/DRIVER/etc). */
  async resetPreview(): Promise<CustomerResetPreviewDto> {
    const customerScope = { user: { role: UserRole.CUSTOMER } };
    const [loyaltyAgg, transactions, reviews, feedback] = await Promise.all([
      this.prisma.loyaltyAccount.aggregate({
        where: customerScope,
        _count: { _all: true },
        _sum: { pointsBalance: true },
      }),
      this.prisma.loyaltyTransaction.count({ where: { account: customerScope } }),
      this.prisma.itemReview.count({ where: customerScope }),
      this.prisma.orderFeedback.count({ where: customerScope }),
    ]);
    return {
      loyaltyAccounts: loyaltyAgg._count._all,
      pointsCleared: loyaltyAgg._sum.pointsBalance ?? 0,
      transactions,
      reviews,
      feedback,
    };
  }

  /** ADMIN-only, non-production-only (see assertResetAllowed): for every
   * CUSTOMER, zeroes their loyalty balance (deleting the ledger) and deletes
   * their item reviews / order feedback. Deliberately keeps the User row —
   * and therefore the account/login — untouched: accounts/addresses/carts/
   * device tokens are never part of this action, unlike AuthService's real
   * account-deletion flow. Independent of OrdersService.adminResetOrders —
   * this never touches Order rows and can be run with or without it. */
  async resetCustomerData(): Promise<CustomerResetPreviewDto> {
    this.assertResetAllowed();
    const preview = await this.resetPreview();
    const customerScope = { user: { role: UserRole.CUSTOMER } };
    await this.prisma.$transaction([
      this.prisma.loyaltyTransaction.deleteMany({ where: { account: customerScope } }),
      this.prisma.loyaltyAccount.updateMany({
        where: customerScope,
        data: { pointsBalance: 0 },
      }),
      this.prisma.itemReview.deleteMany({ where: customerScope }),
      this.prisma.orderFeedback.deleteMany({ where: customerScope }),
    ]);
    return preview;
  }

  private assertResetAllowed(): void {
    if (this.config.get<string>('nodeEnv') === 'production') {
      throw new ForbiddenException({
        message: 'Data reset is disabled in production',
        code: 'RESET_DISABLED_IN_PRODUCTION',
      });
    }
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
