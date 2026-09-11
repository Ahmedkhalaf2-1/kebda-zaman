import { OrderStatus, Prisma } from '@prisma/client';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ReviewsService, assertNotGuest } from './reviews.service';
import { PrismaService } from '../../prisma/prisma.service';

const NON_REVIEWABLE_STATUSES: OrderStatus[] = [
  'PENDING',
  'CONFIRMED',
  'PREPARING',
  'OUT_FOR_DELIVERY',
  'READY_FOR_PICKUP',
  'CANCELLED',
];

function orderItemFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'order-item-1',
    orderId: 'order-1',
    menuItemId: 'menu-item-1',
    order: { id: 'order-1', status: 'DELIVERED' as OrderStatus },
    ...overrides,
  };
}

function reviewFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'review-1',
    userId: 'user-1',
    orderId: 'order-1',
    orderItemId: 'order-item-1',
    menuItemId: 'menu-item-1',
    rating: 5,
    comment: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ReviewsService — item reviews', () => {
  let prisma: {
    orderItem: { findFirst: jest.Mock; findMany: jest.Mock };
    itemReview: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    order: { findFirst: jest.Mock };
    orderFeedback: { findFirst: jest.Mock };
  };
  let service: ReviewsService;

  beforeEach(() => {
    prisma = {
      orderItem: { findFirst: jest.fn(), findMany: jest.fn() },
      itemReview: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      order: { findFirst: jest.fn() },
      orderFeedback: { findFirst: jest.fn() },
    };
    service = new ReviewsService(prisma as unknown as PrismaService);
  });

  describe('createItemReview', () => {
    it('allows reviewing an order item from a DELIVERED order', async () => {
      prisma.orderItem.findFirst.mockResolvedValue(orderItemFixture());
      prisma.itemReview.create.mockResolvedValue(reviewFixture());

      const result = await service.createItemReview('user-1', {
        orderItemId: 'order-item-1',
        rating: 5,
      });

      expect(result.id).toBe('review-1');
      expect(prisma.itemReview.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          orderId: 'order-1',
          orderItemId: 'order-item-1',
          menuItemId: 'menu-item-1',
          rating: 5,
          comment: null,
        },
      });
    });

    it('allows reviewing an order item from a PICKED_UP order', async () => {
      prisma.orderItem.findFirst.mockResolvedValue(
        orderItemFixture({ order: { id: 'order-1', status: 'PICKED_UP' } }),
      );
      prisma.itemReview.create.mockResolvedValue(reviewFixture());

      await expect(
        service.createItemReview('user-1', { orderItemId: 'order-item-1', rating: 4 }),
      ).resolves.toMatchObject({ id: 'review-1' });
    });

    it.each(NON_REVIEWABLE_STATUSES)('rejects an order item from a %s order', async (status) => {
      prisma.orderItem.findFirst.mockResolvedValue(
        orderItemFixture({ order: { id: 'order-1', status } }),
      );

      await expect(
        service.createItemReview('user-1', { orderItemId: 'order-item-1', rating: 5 }),
      ).rejects.toMatchObject({
        constructor: UnprocessableEntityException,
        response: { code: 'ORDER_NOT_ELIGIBLE_FOR_REVIEW' },
      });
      expect(prisma.itemReview.create).not.toHaveBeenCalled();
    });

    it("rejects another customer's order item (scoped query returns nothing) as not found", async () => {
      prisma.orderItem.findFirst.mockResolvedValue(null);

      await expect(
        service.createItemReview('user-1', { orderItemId: 'order-item-1', rating: 5 }),
      ).rejects.toMatchObject({
        constructor: NotFoundException,
        response: { code: 'ORDER_ITEM_NOT_FOUND' },
      });
    });

    it('rejects a duplicate review (pre-check)', async () => {
      prisma.orderItem.findFirst.mockResolvedValue(orderItemFixture());
      prisma.itemReview.findUnique.mockResolvedValue(reviewFixture());

      await expect(
        service.createItemReview('user-1', { orderItemId: 'order-item-1', rating: 5 }),
      ).rejects.toMatchObject({
        constructor: ConflictException,
        response: { code: 'REVIEW_ALREADY_EXISTS' },
      });
      expect(prisma.itemReview.create).not.toHaveBeenCalled();
    });

    it('converts a racing unique-constraint violation on create into a 409', async () => {
      prisma.orderItem.findFirst.mockResolvedValue(orderItemFixture());
      prisma.itemReview.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.2.0',
        }),
      );

      await expect(
        service.createItemReview('user-1', { orderItemId: 'order-item-1', rating: 5 }),
      ).rejects.toMatchObject({
        constructor: ConflictException,
        response: { code: 'REVIEW_ALREADY_EXISTS' },
      });
    });

    it('rejects rating 0', async () => {
      await expect(
        service.createItemReview('user-1', { orderItemId: 'order-item-1', rating: 0 }),
      ).rejects.toMatchObject({
        constructor: BadRequestException,
        response: { code: 'INVALID_RATING' },
      });
      expect(prisma.orderItem.findFirst).not.toHaveBeenCalled();
    });

    it('rejects rating 6', async () => {
      await expect(
        service.createItemReview('user-1', { orderItemId: 'order-item-1', rating: 6 }),
      ).rejects.toMatchObject({
        constructor: BadRequestException,
        response: { code: 'INVALID_RATING' },
      });
    });

    it('accepts and normalizes an optional comment (trims whitespace)', async () => {
      prisma.orderItem.findFirst.mockResolvedValue(orderItemFixture());
      prisma.itemReview.create.mockResolvedValue(reviewFixture({ comment: 'Great!' }));

      await service.createItemReview('user-1', {
        orderItemId: 'order-item-1',
        rating: 5,
        comment: '  Great!  ',
      });

      expect(prisma.itemReview.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ comment: 'Great!' }) }),
      );
    });

    it('collapses a whitespace-only comment to null', async () => {
      prisma.orderItem.findFirst.mockResolvedValue(orderItemFixture());
      prisma.itemReview.create.mockResolvedValue(reviewFixture());

      await service.createItemReview('user-1', {
        orderItemId: 'order-item-1',
        rating: 5,
        comment: '   ',
      });

      expect(prisma.itemReview.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ comment: null }) }),
      );
    });

    it('never trusts a client-supplied menuItemId/orderId — always derives them from the OrderItem', async () => {
      prisma.orderItem.findFirst.mockResolvedValue(orderItemFixture());
      prisma.itemReview.create.mockResolvedValue(reviewFixture());

      await service.createItemReview('user-1', {
        orderItemId: 'order-item-1',
        rating: 5,
        // @ts-expect-error — deliberately probing that extra fields are ignored, not just rejected by the DTO whitelist
        menuItemId: 'attacker-supplied-id',
        orderId: 'attacker-supplied-order',
      });

      expect(prisma.itemReview.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ menuItemId: 'menu-item-1', orderId: 'order-1' }),
        }),
      );
    });
  });

  describe('updateItemReview — PATCH tri-state semantics', () => {
    it('allows the owner to edit both rating and comment together', async () => {
      prisma.itemReview.findFirst.mockResolvedValue(reviewFixture());
      prisma.itemReview.update.mockResolvedValue(reviewFixture({ rating: 3, comment: 'ok' }));

      const result = await service.updateItemReview('user-1', 'review-1', {
        rating: 3,
        comment: 'ok',
      });

      expect(result.rating).toBe(3);
      expect(prisma.itemReview.update).toHaveBeenCalledWith({
        where: { id: 'review-1' },
        data: { rating: 3, comment: 'ok' },
      });
    });

    it('rating-only patch omits comment from the update payload (preserves existing comment)', async () => {
      prisma.itemReview.findFirst.mockResolvedValue(reviewFixture({ comment: 'existing' }));
      prisma.itemReview.update.mockResolvedValue(reviewFixture({ rating: 2, comment: 'existing' }));

      await service.updateItemReview('user-1', 'review-1', { rating: 2 });

      expect(prisma.itemReview.update).toHaveBeenCalledWith({
        where: { id: 'review-1' },
        data: { rating: 2 },
      });
    });

    it('comment-only patch omits rating from the update payload (preserves existing rating)', async () => {
      prisma.itemReview.findFirst.mockResolvedValue(reviewFixture({ rating: 5 }));
      prisma.itemReview.update.mockResolvedValue(reviewFixture({ rating: 5, comment: 'updated' }));

      await service.updateItemReview('user-1', 'review-1', { comment: 'updated' });

      expect(prisma.itemReview.update).toHaveBeenCalledWith({
        where: { id: 'review-1' },
        data: { comment: 'updated' },
      });
    });

    it('an explicit null comment clears it', async () => {
      prisma.itemReview.findFirst.mockResolvedValue(reviewFixture({ comment: 'existing' }));
      prisma.itemReview.update.mockResolvedValue(reviewFixture({ comment: null }));

      await service.updateItemReview('user-1', 'review-1', { comment: null });

      expect(prisma.itemReview.update).toHaveBeenCalledWith({
        where: { id: 'review-1' },
        data: { comment: null },
      });
    });

    it('an empty-string comment clears it', async () => {
      prisma.itemReview.findFirst.mockResolvedValue(reviewFixture({ comment: 'existing' }));
      prisma.itemReview.update.mockResolvedValue(reviewFixture({ comment: null }));

      await service.updateItemReview('user-1', 'review-1', { comment: '' });

      expect(prisma.itemReview.update).toHaveBeenCalledWith({
        where: { id: 'review-1' },
        data: { comment: null },
      });
    });

    it('a whitespace-only comment clears it', async () => {
      prisma.itemReview.findFirst.mockResolvedValue(reviewFixture({ comment: 'existing' }));
      prisma.itemReview.update.mockResolvedValue(reviewFixture({ comment: null }));

      await service.updateItemReview('user-1', 'review-1', { comment: '   ' });

      expect(prisma.itemReview.update).toHaveBeenCalledWith({
        where: { id: 'review-1' },
        data: { comment: null },
      });
    });

    it('rejects an out-of-range rating even when comment is also provided', async () => {
      prisma.itemReview.findFirst.mockResolvedValue(reviewFixture());

      await expect(
        service.updateItemReview('user-1', 'review-1', { rating: 6, comment: 'x' }),
      ).rejects.toMatchObject({
        constructor: BadRequestException,
        response: { code: 'INVALID_RATING' },
      });
      expect(prisma.itemReview.update).not.toHaveBeenCalled();
    });

    it("rejects editing another customer's review (scoped query returns nothing) as not found", async () => {
      prisma.itemReview.findFirst.mockResolvedValue(null);

      await expect(
        service.updateItemReview('user-2', 'review-1', { rating: 3 }),
      ).rejects.toMatchObject({
        constructor: NotFoundException,
        response: { code: 'REVIEW_NOT_FOUND' },
      });
      expect(prisma.itemReview.update).not.toHaveBeenCalled();
    });

    it('never accepts orderId/orderItemId/menuItemId/userId — UpdateItemReviewDto only exposes rating/comment', async () => {
      prisma.itemReview.findFirst.mockResolvedValue(reviewFixture());
      prisma.itemReview.update.mockResolvedValue(reviewFixture({ rating: 2 }));

      await service.updateItemReview('user-1', 'review-1', { rating: 2, comment: 'x' });

      const dataArg = prisma.itemReview.update.mock.calls[0][0].data;
      expect(Object.keys(dataArg).sort()).toEqual(['comment', 'rating']);
    });
  });

  describe('getOrderReviewEligibility', () => {
    it('marks a DELIVERED order eligible and returns every purchased item with its review (or null)', async () => {
      prisma.order.findFirst.mockResolvedValue({ id: 'order-1', status: 'DELIVERED' });
      prisma.orderItem.findMany.mockResolvedValue([
        {
          id: 'order-item-1',
          menuItemId: 'menu-item-1',
          nameArSnapshot: 'ar',
          nameEnSnapshot: 'en',
          imageUrlSnapshot: null,
          quantity: 2,
          review: reviewFixture(),
        },
        {
          id: 'order-item-2',
          menuItemId: 'menu-item-2',
          nameArSnapshot: 'ar2',
          nameEnSnapshot: 'en2',
          imageUrlSnapshot: null,
          quantity: 1,
          review: null,
        },
      ]);
      prisma.orderFeedback.findFirst.mockResolvedValue(null);

      const result = await service.getOrderReviewEligibility('user-1', 'order-1');

      expect(result.eligible).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].review?.id).toBe('review-1');
      expect(result.items[1].review).toBeNull();
      expect(result.orderFeedback).toBeNull();
    });

    it('marks a PENDING order not eligible', async () => {
      prisma.order.findFirst.mockResolvedValue({ id: 'order-1', status: 'PENDING' });
      prisma.orderItem.findMany.mockResolvedValue([]);
      prisma.orderFeedback.findFirst.mockResolvedValue(null);

      const result = await service.getOrderReviewEligibility('user-1', 'order-1');

      expect(result.eligible).toBe(false);
    });

    it("rejects another customer's order (scoped query returns nothing) as not found", async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(service.getOrderReviewEligibility('user-1', 'order-1')).rejects.toMatchObject({
        constructor: NotFoundException,
        response: { code: 'ORDER_NOT_FOUND' },
      });
    });
  });

  describe('assertNotGuest', () => {
    it('rejects a guest account', () => {
      expect(() => assertNotGuest(true)).toThrow(ForbiddenException);
    });

    it('allows a non-guest account', () => {
      expect(() => assertNotGuest(false)).not.toThrow();
    });
  });
});
