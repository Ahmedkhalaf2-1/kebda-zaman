import { Injectable } from '@nestjs/common';
import { DeliveryMethod, OrderStatus, PaymentMethod, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ReportDateRangeDto } from './dto/report-date-range.dto';
import { SalesTimelineQueryDto } from './dto/sales-timeline-query.dto';
import { TopItemsQueryDto } from './dto/top-items-query.dto';
import { dateRangeWhereClause, resolveBoundedDateRange, resolveDateRange } from './date-range.util';
import { assertBucketCountReasonable, bucketStart, nextBucket, periodKey } from './sales-timeline.util';

const ALL_ORDER_STATUSES: OrderStatus[] = [
  'PENDING',
  'CONFIRMED',
  'PREPARING',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
];
const ALL_DELIVERY_METHODS: DeliveryMethod[] = ['DELIVERY', 'PICKUP'];
const ALL_PAYMENT_METHODS: PaymentMethod[] = ['CASH', 'CARD', 'WALLET'];

export interface ReportOverviewDto {
  totalRevenue: number;
  totalOrders: number;
  deliveredOrders: number;
  cancelledOrders: number;
  averageOrderValue: number;
  activeCustomers: number;
  newCustomers: number;
  deliveryOrders: number;
  pickupOrders: number;
  cashOrders: number;
  cardOrders: number;
}

export interface SalesPeriodDto {
  period: string;
  revenue: number;
  orderCount: number;
  deliveredOrderCount: number;
}

export interface OrderBreakdownDto {
  byStatus: { status: OrderStatus; count: number }[];
  byFulfillmentType: { type: DeliveryMethod; count: number }[];
  byPaymentMethod: { method: PaymentMethod; count: number }[];
}

export interface TopItemDto {
  menuItemId: string;
  nameAr: string;
  nameEn: string;
  quantitySold: number;
  revenue: number;
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(query: ReportDateRangeDto): Promise<ReportOverviewDto> {
    const createdAtFilter = dateRangeWhereClause(resolveDateRange(query.from, query.to));
    const whereBase: Prisma.OrderWhereInput = createdAtFilter ? { createdAt: createdAtFilter } : {};

    const [
      totalOrders,
      deliveredAgg,
      cancelledOrders,
      byDeliveryMethod,
      byPaymentMethod,
      activeCustomers,
      newCustomers,
    ] = await Promise.all([
      this.prisma.order.count({ where: whereBase }),
      this.prisma.order.aggregate({
        where: { ...whereBase, status: OrderStatus.DELIVERED },
        _sum: { totalAmount: true },
        _count: { _all: true },
      }),
      this.prisma.order.count({ where: { ...whereBase, status: OrderStatus.CANCELLED } }),
      this.prisma.order.groupBy({ by: ['deliveryMethod'], where: whereBase, _count: { _all: true } }),
      this.prisma.order.groupBy({ by: ['paymentMethod'], where: whereBase, _count: { _all: true } }),
      this.prisma.user.count({ where: { role: UserRole.CUSTOMER, deletedAt: null } }),
      this.prisma.user.count({
        where: { role: UserRole.CUSTOMER, ...(createdAtFilter ? { createdAt: createdAtFilter } : {}) },
      }),
    ]);

    const deliveredOrders = deliveredAgg._count._all;
    const totalRevenue = deliveredAgg._sum.totalAmount?.toNumber() ?? 0;
    const averageOrderValue = deliveredOrders > 0 ? totalRevenue / deliveredOrders : 0;

    const deliveryCount = (method: DeliveryMethod) =>
      byDeliveryMethod.find((r) => r.deliveryMethod === method)?._count._all ?? 0;
    const paymentCount = (method: PaymentMethod) =>
      byPaymentMethod.find((r) => r.paymentMethod === method)?._count._all ?? 0;

    return {
      totalRevenue,
      totalOrders,
      deliveredOrders,
      cancelledOrders,
      averageOrderValue,
      activeCustomers,
      newCustomers,
      deliveryOrders: deliveryCount(DeliveryMethod.DELIVERY),
      pickupOrders: deliveryCount(DeliveryMethod.PICKUP),
      cashOrders: paymentCount(PaymentMethod.CASH),
      cardOrders: paymentCount(PaymentMethod.CARD),
    };
  }

  async getSalesTimeline(query: SalesTimelineQueryDto): Promise<SalesPeriodDto[]> {
    const groupBy = query.groupBy ?? 'day';
    const { from, to } = resolveBoundedDateRange(query.from, query.to);
    assertBucketCountReasonable(from, to, groupBy);

    const orders = await this.prisma.order.findMany({
      where: { createdAt: { gte: from, lte: to } },
      select: { createdAt: true, status: true, totalAmount: true },
    });

    const buckets = new Map<string, SalesPeriodDto>();
    for (
      let cursor = bucketStart(from, groupBy);
      cursor.getTime() <= to.getTime();
      cursor = nextBucket(cursor, groupBy)
    ) {
      const key = periodKey(cursor, groupBy);
      buckets.set(key, { period: key, revenue: 0, orderCount: 0, deliveredOrderCount: 0 });
    }

    for (const order of orders) {
      const key = periodKey(bucketStart(order.createdAt, groupBy), groupBy);
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.orderCount += 1;
      if (order.status === OrderStatus.DELIVERED) {
        bucket.deliveredOrderCount += 1;
        bucket.revenue += order.totalAmount.toNumber();
      }
    }

    return [...buckets.values()];
  }

  async getOrderBreakdown(query: ReportDateRangeDto): Promise<OrderBreakdownDto> {
    const createdAtFilter = dateRangeWhereClause(resolveDateRange(query.from, query.to));
    const whereBase: Prisma.OrderWhereInput = createdAtFilter ? { createdAt: createdAtFilter } : {};

    const [byStatus, byFulfillmentType, byPaymentMethod] = await Promise.all([
      this.prisma.order.groupBy({ by: ['status'], where: whereBase, _count: { _all: true } }),
      this.prisma.order.groupBy({ by: ['deliveryMethod'], where: whereBase, _count: { _all: true } }),
      this.prisma.order.groupBy({ by: ['paymentMethod'], where: whereBase, _count: { _all: true } }),
    ]);

    return {
      byStatus: ALL_ORDER_STATUSES.map((status) => ({
        status,
        count: byStatus.find((r) => r.status === status)?._count._all ?? 0,
      })),
      byFulfillmentType: ALL_DELIVERY_METHODS.map((type) => ({
        type,
        count: byFulfillmentType.find((r) => r.deliveryMethod === type)?._count._all ?? 0,
      })),
      byPaymentMethod: ALL_PAYMENT_METHODS.map((method) => ({
        method,
        count: byPaymentMethod.find((r) => r.paymentMethod === method)?._count._all ?? 0,
      })),
    };
  }

  async getTopItems(query: TopItemsQueryDto): Promise<TopItemDto[]> {
    const limit = query.limit ?? 10;
    const createdAtFilter = dateRangeWhereClause(resolveDateRange(query.from, query.to));

    const grouped = await this.prisma.orderItem.groupBy({
      by: ['menuItemId'],
      where: {
        menuItemId: { not: null },
        order: {
          status: OrderStatus.DELIVERED,
          ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
        },
      },
      _sum: { quantity: true, lineTotal: true },
    });

    const ranked = grouped
      .filter((row): row is typeof row & { menuItemId: string } => row.menuItemId !== null)
      .sort((a, b) => {
        const qtyDiff = (b._sum.quantity ?? 0) - (a._sum.quantity ?? 0);
        if (qtyDiff !== 0) return qtyDiff;
        return (b._sum.lineTotal?.toNumber() ?? 0) - (a._sum.lineTotal?.toNumber() ?? 0);
      })
      .slice(0, limit);

    if (ranked.length === 0) {
      return [];
    }

    const topIds = ranked.map((r) => r.menuItemId);
    const snapshots = await this.prisma.orderItem.findMany({
      where: { menuItemId: { in: topIds } },
      distinct: ['menuItemId'],
      orderBy: { createdAt: 'desc' },
      select: { menuItemId: true, nameArSnapshot: true, nameEnSnapshot: true },
    });
    const nameById = new Map(snapshots.map((s) => [s.menuItemId as string, s]));

    return ranked.map((row) => {
      const snapshot = nameById.get(row.menuItemId);
      return {
        menuItemId: row.menuItemId,
        nameAr: snapshot?.nameArSnapshot ?? '',
        nameEn: snapshot?.nameEnSnapshot ?? '',
        quantitySold: row._sum.quantity ?? 0,
        revenue: row._sum.lineTotal?.toNumber() ?? 0,
      };
    });
  }
}
