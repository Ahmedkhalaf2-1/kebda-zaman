import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { dateRangeWhereClause, resolveDateRange } from '../reports/date-range.util';
import {
  AdminReviewsSummaryDto,
  ItemReviewResponseDto,
  OrderFeedbackResponseDto,
  OrderReviewEligibilityResponseDto,
  RatingAggregateDto,
  RatingDistributionDto,
  TopRatedMenuItemDto,
  emptyRatingAggregate,
  roundRating,
  toAdminItemReviewResponse,
  toAdminOrderFeedbackResponse,
  toItemReviewResponse,
  toOrderFeedbackResponse,
  toOrderReviewEligibilityResponse,
} from '../../common/mappers/review-response.mapper';
import { CreateItemReviewDto } from './dto/create-item-review.dto';
import { UpdateItemReviewDto } from './dto/update-item-review.dto';
import { CreateOrderFeedbackDto } from './dto/create-order-feedback.dto';
import { UpdateOrderFeedbackDto } from './dto/update-order-feedback.dto';
import { AdminListItemReviewsDto } from './dto/admin-list-item-reviews.dto';
import { AdminListOrderFeedbackDto } from './dto/admin-list-order-feedback.dto';

/** An order is reviewable once it has actually reached the customer — either
 * delivered to their door or picked up in person. Every earlier/other status
 * (including CANCELLED) is not eligible. */
const REVIEWABLE_ORDER_STATUSES: OrderStatus[] = ['DELIVERED', 'PICKED_UP'];

/** Minimum review count for a menu item to appear in the admin summary's
 * top/lowest-rated lists — prevents a single 5-star (or 1-star) review from
 * dominating the ranking. Defined here, explicitly, per product ask. */
const MIN_REVIEWS_FOR_RANKING = 5;

const TOP_RATED_LIMIT = 5;

const itemReviewAdminInclude = {
  user: { select: { id: true, fullName: true, email: true, phone: true } },
  order: { select: { id: true, orderNumber: true } },
  orderItem: {
    select: {
      id: true,
      menuItemId: true,
      nameArSnapshot: true,
      nameEnSnapshot: true,
      imageUrlSnapshot: true,
    },
  },
} satisfies Prisma.ItemReviewInclude;

const orderFeedbackAdminInclude = {
  user: { select: { id: true, fullName: true, email: true, phone: true } },
  order: { select: { id: true, orderNumber: true } },
} satisfies Prisma.OrderFeedbackInclude;

/** Guests are excluded up front by role+guest gating in the controller; this mirrors that intent for direct service callers. */
export function assertNotGuest(isGuest: boolean): void {
  if (isGuest) {
    throw new ForbiddenException({
      message: 'Guest accounts cannot submit reviews',
      code: 'GUEST_CANNOT_REVIEW',
    });
  }
}

function assertValidRating(rating: number): void {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new BadRequestException({
      message: 'Rating must be an integer between 1 and 5',
      code: 'INVALID_RATING',
    });
  }
}

/** Trims, collapses an empty string to `null`, and leaves `undefined`/`null` as `null`. */
function normalizeComment(comment?: string | null): string | null {
  if (comment === undefined || comment === null) {
    return null;
  }
  const trimmed = comment.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function assertOrderEligible(status: OrderStatus): void {
  if (!REVIEWABLE_ORDER_STATUSES.includes(status)) {
    throw new UnprocessableEntityException({
      message:
        'This order is not yet eligible for review — it must be delivered or picked up first',
      code: 'ORDER_NOT_ELIGIBLE_FOR_REVIEW',
    });
  }
}

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // Customer — item reviews
  // ===========================================================================

  /**
   * Validation sequence (product spec): guest check -> load OrderItem+Order,
   * scoped to the caller (IDOR-safe — a wrong-owner id is indistinguishable
   * from a nonexistent one) -> order-eligibility check -> duplicate pre-check
   * -> create. userId/orderId/menuItemId are always server-derived, never
   * trusted from the client.
   */
  async createItemReview(userId: string, dto: CreateItemReviewDto): Promise<ItemReviewResponseDto> {
    assertValidRating(dto.rating);

    const orderItem = await this.prisma.orderItem.findFirst({
      where: { id: dto.orderItemId, order: { userId } },
      include: { order: { select: { id: true, status: true } } },
    });
    if (!orderItem) {
      throw new NotFoundException({
        message: 'Order item not found',
        code: 'ORDER_ITEM_NOT_FOUND',
      });
    }
    assertOrderEligible(orderItem.order.status);

    const existing = await this.prisma.itemReview.findUnique({
      where: { orderItemId: dto.orderItemId },
    });
    if (existing) {
      throw new ConflictException({
        message: 'A review already exists for this order item',
        code: 'REVIEW_ALREADY_EXISTS',
      });
    }

    try {
      const review = await this.prisma.itemReview.create({
        data: {
          userId,
          orderId: orderItem.order.id,
          orderItemId: orderItem.id,
          menuItemId: orderItem.menuItemId,
          rating: dto.rating,
          comment: normalizeComment(dto.comment),
        },
      });
      return toItemReviewResponse(review);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException({
          message: 'A review already exists for this order item',
          code: 'REVIEW_ALREADY_EXISTS',
        });
      }
      throw error;
    }
  }

  /**
   * Only the review owner may edit (findFirst scoped to userId — 404, not
   * 403, for a wrong owner). The order still belonging to the same owner is
   * implied by that same check: a review's userId/orderId never change after
   * creation, and orders are never reassigned between customers. rating/
   * comment are the only mutable fields — orderId/orderItemId/menuItemId/
   * userId aren't even present on UpdateItemReviewDto, so there is nothing to
   * accidentally overwrite.
   *
   * PATCH tri-state semantics (same convention as CatalogService.
   * updateMenuItem): a field omitted from the body is left out of the Prisma
   * update payload entirely, so it preserves its existing value — it is NOT
   * the same as passing `null`, which explicitly clears `comment`.
   */
  async updateItemReview(
    userId: string,
    reviewId: string,
    dto: UpdateItemReviewDto,
  ): Promise<ItemReviewResponseDto> {
    const existing = await this.prisma.itemReview.findFirst({ where: { id: reviewId, userId } });
    if (!existing) {
      throw new NotFoundException({ message: 'Review not found', code: 'REVIEW_NOT_FOUND' });
    }

    const data: Prisma.ItemReviewUpdateInput = {};
    if (dto.rating !== undefined) {
      assertValidRating(dto.rating);
      data.rating = dto.rating;
    }
    if (dto.comment !== undefined) {
      data.comment = normalizeComment(dto.comment);
    }

    const updated = await this.prisma.itemReview.update({ where: { id: reviewId }, data });
    return toItemReviewResponse(updated);
  }

  /** GET /reviews/me/orders/:orderId — every purchased line, reviewed or not, from the order's own snapshots. */
  async getOrderReviewEligibility(
    userId: string,
    orderId: string,
  ): Promise<OrderReviewEligibilityResponseDto> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      select: { id: true, status: true },
    });
    if (!order) {
      throw new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
    }

    const [items, feedback] = await Promise.all([
      this.prisma.orderItem.findMany({
        where: { orderId },
        include: { review: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.orderFeedback.findFirst({ where: { orderId } }),
    ]);

    return toOrderReviewEligibilityResponse(
      order,
      items,
      feedback,
      REVIEWABLE_ORDER_STATUSES.includes(order.status),
    );
  }

  // ===========================================================================
  // Customer — overall order feedback
  // ===========================================================================

  async createOrderFeedback(
    userId: string,
    dto: CreateOrderFeedbackDto,
  ): Promise<OrderFeedbackResponseDto> {
    assertValidRating(dto.rating);

    const order = await this.prisma.order.findFirst({
      where: { id: dto.orderId, userId },
      select: { id: true, status: true },
    });
    if (!order) {
      throw new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
    }
    assertOrderEligible(order.status);

    const existing = await this.prisma.orderFeedback.findUnique({
      where: { orderId: dto.orderId },
    });
    if (existing) {
      throw new ConflictException({
        message: 'Feedback already exists for this order',
        code: 'ORDER_FEEDBACK_ALREADY_EXISTS',
      });
    }

    try {
      const feedback = await this.prisma.orderFeedback.create({
        data: {
          userId,
          orderId: order.id,
          rating: dto.rating,
          comment: normalizeComment(dto.comment),
        },
      });
      return toOrderFeedbackResponse(feedback);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException({
          message: 'Feedback already exists for this order',
          code: 'ORDER_FEEDBACK_ALREADY_EXISTS',
        });
      }
      throw error;
    }
  }

  /**
   * PATCH tri-state semantics (same convention as CatalogService.
   * updateMenuItem, and as ReviewsService.updateItemReview above): a field
   * omitted from the body preserves its existing value; an explicit
   * `comment: null` (or blank/whitespace-only string) clears it.
   */
  async updateOrderFeedback(
    userId: string,
    feedbackId: string,
    dto: UpdateOrderFeedbackDto,
  ): Promise<OrderFeedbackResponseDto> {
    const existing = await this.prisma.orderFeedback.findFirst({
      where: { id: feedbackId, userId },
    });
    if (!existing) {
      throw new NotFoundException({
        message: 'Order feedback not found',
        code: 'ORDER_FEEDBACK_NOT_FOUND',
      });
    }

    const data: Prisma.OrderFeedbackUpdateInput = {};
    if (dto.rating !== undefined) {
      assertValidRating(dto.rating);
      data.rating = dto.rating;
    }
    if (dto.comment !== undefined) {
      data.comment = normalizeComment(dto.comment);
    }

    const updated = await this.prisma.orderFeedback.update({ where: { id: feedbackId }, data });
    return toOrderFeedbackResponse(updated);
  }

  // ===========================================================================
  // Admin
  // ===========================================================================

  async adminListItemReviews(query: AdminListItemReviewsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const range = resolveDateRange(query.from, query.to);
    const createdAt = dateRangeWhereClause(range);

    const reviews = await this.prisma.itemReview.findMany({
      where: {
        ...(query.rating ? { rating: query.rating } : {}),
        ...(query.menuItemId ? { menuItemId: query.menuItemId } : {}),
        ...(query.orderId ? { orderId: query.orderId } : {}),
        ...(query.userId ? { userId: query.userId } : {}),
        ...(createdAt ? { createdAt } : {}),
      },
      include: itemReviewAdminInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return reviews.map(toAdminItemReviewResponse);
  }

  async adminListOrderFeedback(query: AdminListOrderFeedbackDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const range = resolveDateRange(query.from, query.to);
    const createdAt = dateRangeWhereClause(range);

    const feedback = await this.prisma.orderFeedback.findMany({
      where: {
        ...(query.rating ? { rating: query.rating } : {}),
        ...(query.orderId ? { orderId: query.orderId } : {}),
        ...(query.userId ? { userId: query.userId } : {}),
        ...(createdAt ? { createdAt } : {}),
      },
      include: orderFeedbackAdminInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return feedback.map(toAdminOrderFeedbackResponse);
  }

  async adminSummary(): Promise<AdminReviewsSummaryDto> {
    const [itemAggregate, orderFeedbackAggregate, topRatedItems, lowestRatedItems] =
      await Promise.all([
        this.aggregateItemReviewRatings({}),
        this.aggregateOrderFeedbackRatings(),
        this.rankMenuItemsByRating('desc'),
        this.rankMenuItemsByRating('asc'),
      ]);

    return {
      itemReviews: {
        averageRating: itemAggregate.averageRating,
        reviewCount: itemAggregate.reviewCount,
      },
      orderFeedback: orderFeedbackAggregate,
      ratingDistribution: itemAggregate.distribution,
      topRatedItems,
      lowestRatedItems,
    };
  }

  // ===========================================================================
  // Reusable aggregates
  // ===========================================================================

  /** Public per-menu-item summary (average/count/distribution) — used by admin, and available for a future per-item public endpoint. */
  async getMenuItemRatingSummary(menuItemId: string): Promise<RatingAggregateDto> {
    return this.aggregateItemReviewRatings({ menuItemId });
  }

  /**
   * Batch-fetches {averageRating, reviewCount} for many menu items in ONE
   * query (`groupBy`) — the catalog list/search/featured endpoints call this
   * with the current page's item ids so displaying ratings never turns into
   * a per-item COUNT/AVG query (no N+1).
   */
  async getMenuItemRatingAggregates(
    menuItemIds: string[],
  ): Promise<Map<string, { averageRating: number; reviewCount: number }>> {
    const result = new Map<string, { averageRating: number; reviewCount: number }>();
    if (menuItemIds.length === 0) {
      return result;
    }
    const grouped = await this.prisma.itemReview.groupBy({
      by: ['menuItemId'],
      where: { menuItemId: { in: menuItemIds } },
      _avg: { rating: true },
      _count: { _all: true },
    });
    for (const row of grouped) {
      if (!row.menuItemId) {
        continue;
      }
      result.set(row.menuItemId, {
        averageRating: roundRating(row._avg.rating ?? 0),
        reviewCount: row._count._all,
      });
    }
    return result;
  }

  /** Reusable rating aggregate (average + count + 1-5 distribution) for any ItemReview filter — a single menu item, or `{}` for the whole table. */
  private async aggregateItemReviewRatings(
    where: Prisma.ItemReviewWhereInput,
  ): Promise<RatingAggregateDto> {
    const grouped = await this.prisma.itemReview.groupBy({
      by: ['rating'],
      where,
      _count: { _all: true },
    });
    if (grouped.length === 0) {
      return emptyRatingAggregate();
    }

    const distribution: RatingDistributionDto = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    let reviewCount = 0;
    let ratingSum = 0;
    for (const row of grouped) {
      const key = String(row.rating) as keyof RatingDistributionDto;
      if (key in distribution) {
        distribution[key] = row._count._all;
      }
      reviewCount += row._count._all;
      ratingSum += row.rating * row._count._all;
    }

    return {
      averageRating: reviewCount === 0 ? 0 : roundRating(ratingSum / reviewCount),
      reviewCount,
      distribution,
    };
  }

  private async aggregateOrderFeedbackRatings(): Promise<{
    averageRating: number;
    reviewCount: number;
  }> {
    const aggregate = await this.prisma.orderFeedback.aggregate({
      _avg: { rating: true },
      _count: { _all: true },
    });
    return {
      averageRating: aggregate._count._all === 0 ? 0 : roundRating(aggregate._avg.rating ?? 0),
      reviewCount: aggregate._count._all,
    };
  }

  /**
   * Top/lowest-rated menu items for the admin summary. Only items with at
   * least `MIN_REVIEWS_FOR_RANKING` reviews are considered, so a single
   * 5-star (or 1-star) review can never dominate the ranking. Sort is
   * deterministic: rating, then review count, then menuItemId, all as
   * explicit tie-breakers — never relies on incidental row order.
   */
  private async rankMenuItemsByRating(direction: 'asc' | 'desc'): Promise<TopRatedMenuItemDto[]> {
    const grouped = await this.prisma.itemReview.groupBy({
      by: ['menuItemId'],
      where: { menuItemId: { not: null } },
      _avg: { rating: true },
      _count: { _all: true },
    });
    const eligible = grouped.filter(
      (row): row is typeof row & { menuItemId: string } =>
        row.menuItemId !== null && row._count._all >= MIN_REVIEWS_FOR_RANKING,
    );
    if (eligible.length === 0) {
      return [];
    }

    const menuItems = await this.prisma.menuItem.findMany({
      where: { id: { in: eligible.map((row) => row.menuItemId) } },
      select: { id: true, nameAr: true, nameEn: true, imageUrl: true },
    });
    const menuItemById = new Map(menuItems.map((item) => [item.id, item]));

    const entries: TopRatedMenuItemDto[] = eligible.map((row) => ({
      menuItemId: row.menuItemId,
      nameAr: menuItemById.get(row.menuItemId)?.nameAr ?? null,
      nameEn: menuItemById.get(row.menuItemId)?.nameEn ?? null,
      imageUrl: menuItemById.get(row.menuItemId)?.imageUrl ?? null,
      averageRating: roundRating(row._avg.rating ?? 0),
      reviewCount: row._count._all,
    }));

    const sign = direction === 'desc' ? -1 : 1;
    entries.sort((a, b) => {
      if (a.averageRating !== b.averageRating) {
        return sign * (a.averageRating - b.averageRating);
      }
      if (a.reviewCount !== b.reviewCount) {
        return b.reviewCount - a.reviewCount;
      }
      return a.menuItemId.localeCompare(b.menuItemId);
    });

    return entries.slice(0, TOP_RATED_LIMIT);
  }
}
