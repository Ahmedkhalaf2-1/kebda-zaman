import { ItemReview, Order, OrderItem, OrderFeedback, User } from '@prisma/client';
import { toFrontendStatus } from './order-response.mapper';

/** Customer-facing item review — never exposes another user's identity. */
export interface ItemReviewResponseDto {
  id: string;
  orderItemId: string;
  menuItemId: string | null;
  rating: number;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toItemReviewResponse(review: ItemReview): ItemReviewResponseDto {
  return {
    id: review.id,
    orderItemId: review.orderItemId,
    menuItemId: review.menuItemId,
    rating: review.rating,
    comment: review.comment,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
  };
}

/** Customer-facing overall order feedback. */
export interface OrderFeedbackResponseDto {
  id: string;
  orderId: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toOrderFeedbackResponse(feedback: OrderFeedback): OrderFeedbackResponseDto {
  return {
    id: feedback.id,
    orderId: feedback.orderId,
    rating: feedback.rating,
    comment: feedback.comment,
    createdAt: feedback.createdAt.toISOString(),
    updatedAt: feedback.updatedAt.toISOString(),
  };
}

/**
 * GET /reviews/me/orders/:orderId — one row per purchased OrderItem (reviewed
 * or not), built from the order's own immutable snapshot fields, never a live
 * MenuItem join, so it reads correctly even after the item is renamed/deleted.
 */
export interface ReviewableOrderItemDto {
  orderItemId: string;
  menuItemId: string | null;
  nameAr: string;
  nameEn: string;
  imageUrl: string | null;
  quantity: number;
  review: ItemReviewResponseDto | null;
}

export interface OrderReviewEligibilityResponseDto {
  orderId: string;
  orderStatus: string;
  eligible: boolean;
  items: ReviewableOrderItemDto[];
  orderFeedback: OrderFeedbackResponseDto | null;
}

export function toOrderReviewEligibilityResponse(
  order: Pick<Order, 'id' | 'status'>,
  items: (OrderItem & { review: ItemReview | null })[],
  orderFeedback: OrderFeedback | null,
  eligible: boolean,
): OrderReviewEligibilityResponseDto {
  return {
    orderId: order.id,
    orderStatus: toFrontendStatus(order.status),
    eligible,
    items: items.map((item) => ({
      orderItemId: item.id,
      menuItemId: item.menuItemId,
      nameAr: item.nameArSnapshot,
      nameEn: item.nameEnSnapshot,
      imageUrl: item.imageUrlSnapshot,
      quantity: item.quantity,
      review: item.review ? toItemReviewResponse(item.review) : null,
    })),
    orderFeedback: orderFeedback ? toOrderFeedbackResponse(orderFeedback) : null,
  };
}

/** Admin view — includes customer identity + order/item context (internal operational API only). */
export interface AdminReviewCustomerDto {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
}

export interface AdminReviewOrderDto {
  id: string;
  orderNumber: string;
}

export interface AdminItemReviewItemDto {
  orderItemId: string;
  menuItemId: string | null;
  nameAr: string;
  nameEn: string;
  imageUrl: string | null;
}

export interface AdminItemReviewResponseDto {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
  customer: AdminReviewCustomerDto;
  order: AdminReviewOrderDto;
  item: AdminItemReviewItemDto;
}

export type AdminItemReviewWithRelations = ItemReview & {
  user: Pick<User, 'id' | 'fullName' | 'email' | 'phone'>;
  order: Pick<Order, 'id' | 'orderNumber'>;
  orderItem: Pick<
    OrderItem,
    'id' | 'menuItemId' | 'nameArSnapshot' | 'nameEnSnapshot' | 'imageUrlSnapshot'
  >;
};

export function toAdminItemReviewResponse(
  review: AdminItemReviewWithRelations,
): AdminItemReviewResponseDto {
  return {
    id: review.id,
    rating: review.rating,
    comment: review.comment,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
    customer: {
      id: review.user.id,
      fullName: review.user.fullName,
      email: review.user.email,
      phone: review.user.phone,
    },
    order: {
      id: review.order.id,
      orderNumber: review.order.orderNumber,
    },
    item: {
      orderItemId: review.orderItem.id,
      menuItemId: review.orderItem.menuItemId,
      nameAr: review.orderItem.nameArSnapshot,
      nameEn: review.orderItem.nameEnSnapshot,
      imageUrl: review.orderItem.imageUrlSnapshot,
    },
  };
}

export interface AdminOrderFeedbackResponseDto {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
  customer: AdminReviewCustomerDto;
  order: AdminReviewOrderDto;
}

export type AdminOrderFeedbackWithRelations = OrderFeedback & {
  user: Pick<User, 'id' | 'fullName' | 'email' | 'phone'>;
  order: Pick<Order, 'id' | 'orderNumber'>;
};

export function toAdminOrderFeedbackResponse(
  feedback: AdminOrderFeedbackWithRelations,
): AdminOrderFeedbackResponseDto {
  return {
    id: feedback.id,
    rating: feedback.rating,
    comment: feedback.comment,
    createdAt: feedback.createdAt.toISOString(),
    updatedAt: feedback.updatedAt.toISOString(),
    customer: {
      id: feedback.user.id,
      fullName: feedback.user.fullName,
      email: feedback.user.email,
      phone: feedback.user.phone,
    },
    order: {
      id: feedback.order.id,
      orderNumber: feedback.order.orderNumber,
    },
  };
}

/** Shared 1-5 rating distribution shape — reused for a single menu item and for admin-wide summaries. */
export interface RatingDistributionDto {
  '1': number;
  '2': number;
  '3': number;
  '4': number;
  '5': number;
}

export interface RatingAggregateDto {
  averageRating: number;
  reviewCount: number;
  distribution: RatingDistributionDto;
}

/** Rounds to 2 decimals, consistently, everywhere an average rating is reported. */
export function roundRating(value: number): number {
  return Math.round(value * 100) / 100;
}

export function emptyRatingAggregate(): RatingAggregateDto {
  return {
    averageRating: 0,
    reviewCount: 0,
    distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
  };
}

/** GET /admin/reviews/summary — one row per menu item in the top/lowest-rated lists. */
export interface TopRatedMenuItemDto {
  menuItemId: string;
  nameAr: string | null;
  nameEn: string | null;
  imageUrl: string | null;
  averageRating: number;
  reviewCount: number;
}

export interface AdminReviewsSummaryDto {
  itemReviews: { averageRating: number; reviewCount: number };
  orderFeedback: { averageRating: number; reviewCount: number };
  ratingDistribution: RatingDistributionDto;
  topRatedItems: TopRatedMenuItemDto[];
  lowestRatedItems: TopRatedMenuItemDto[];
}
