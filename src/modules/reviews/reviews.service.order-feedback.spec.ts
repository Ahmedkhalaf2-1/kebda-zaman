import { Prisma } from '@prisma/client';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { PrismaService } from '../../prisma/prisma.service';

function feedbackFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'feedback-1',
    userId: 'user-1',
    orderId: 'order-1',
    rating: 4,
    comment: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ReviewsService — order feedback', () => {
  let prisma: {
    order: { findFirst: jest.Mock };
    orderFeedback: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let service: ReviewsService;

  beforeEach(() => {
    prisma = {
      order: { findFirst: jest.fn() },
      orderFeedback: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    service = new ReviewsService(prisma as unknown as PrismaService);
  });

  describe('createOrderFeedback', () => {
    it('creates feedback for a completed (DELIVERED) order owned by the caller', async () => {
      prisma.order.findFirst.mockResolvedValue({ id: 'order-1', status: 'DELIVERED' });
      prisma.orderFeedback.create.mockResolvedValue(feedbackFixture());

      const result = await service.createOrderFeedback('user-1', { orderId: 'order-1', rating: 4 });

      expect(result.id).toBe('feedback-1');
      expect(prisma.orderFeedback.create).toHaveBeenCalledWith({
        data: { userId: 'user-1', orderId: 'order-1', rating: 4, comment: null },
      });
    });

    it('rejects an order that has not reached a completed status', async () => {
      prisma.order.findFirst.mockResolvedValue({ id: 'order-1', status: 'PREPARING' });

      await expect(
        service.createOrderFeedback('user-1', { orderId: 'order-1', rating: 4 }),
      ).rejects.toMatchObject({
        constructor: UnprocessableEntityException,
        response: { code: 'ORDER_NOT_ELIGIBLE_FOR_REVIEW' },
      });
    });

    it("rejects an order that doesn't belong to the caller as not found", async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(
        service.createOrderFeedback('user-1', { orderId: 'order-1', rating: 4 }),
      ).rejects.toMatchObject({
        constructor: NotFoundException,
        response: { code: 'ORDER_NOT_FOUND' },
      });
    });

    it('rejects a duplicate order feedback (pre-check)', async () => {
      prisma.order.findFirst.mockResolvedValue({ id: 'order-1', status: 'DELIVERED' });
      prisma.orderFeedback.findUnique.mockResolvedValue(feedbackFixture());

      await expect(
        service.createOrderFeedback('user-1', { orderId: 'order-1', rating: 4 }),
      ).rejects.toMatchObject({
        constructor: ConflictException,
        response: { code: 'ORDER_FEEDBACK_ALREADY_EXISTS' },
      });
      expect(prisma.orderFeedback.create).not.toHaveBeenCalled();
    });

    it('converts a racing unique-constraint violation on create into a 409', async () => {
      prisma.order.findFirst.mockResolvedValue({ id: 'order-1', status: 'DELIVERED' });
      prisma.orderFeedback.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.2.0',
        }),
      );

      await expect(
        service.createOrderFeedback('user-1', { orderId: 'order-1', rating: 4 }),
      ).rejects.toMatchObject({
        constructor: ConflictException,
        response: { code: 'ORDER_FEEDBACK_ALREADY_EXISTS' },
      });
    });
  });

  describe('updateOrderFeedback — PATCH tri-state semantics', () => {
    it('allows the owner to edit both rating and comment together', async () => {
      prisma.orderFeedback.findFirst.mockResolvedValue(feedbackFixture());
      prisma.orderFeedback.update.mockResolvedValue(feedbackFixture({ rating: 2, comment: 'meh' }));

      const result = await service.updateOrderFeedback('user-1', 'feedback-1', {
        rating: 2,
        comment: 'meh',
      });

      expect(result.rating).toBe(2);
      expect(prisma.orderFeedback.update).toHaveBeenCalledWith({
        where: { id: 'feedback-1' },
        data: { rating: 2, comment: 'meh' },
      });
    });

    it('rating-only patch omits comment from the update payload (preserves existing comment)', async () => {
      prisma.orderFeedback.findFirst.mockResolvedValue(feedbackFixture({ comment: 'existing' }));
      prisma.orderFeedback.update.mockResolvedValue(
        feedbackFixture({ rating: 1, comment: 'existing' }),
      );

      await service.updateOrderFeedback('user-1', 'feedback-1', { rating: 1 });

      expect(prisma.orderFeedback.update).toHaveBeenCalledWith({
        where: { id: 'feedback-1' },
        data: { rating: 1 },
      });
    });

    it('comment-only patch omits rating from the update payload (preserves existing rating)', async () => {
      prisma.orderFeedback.findFirst.mockResolvedValue(feedbackFixture({ rating: 5 }));
      prisma.orderFeedback.update.mockResolvedValue(
        feedbackFixture({ rating: 5, comment: 'updated' }),
      );

      await service.updateOrderFeedback('user-1', 'feedback-1', { comment: 'updated' });

      expect(prisma.orderFeedback.update).toHaveBeenCalledWith({
        where: { id: 'feedback-1' },
        data: { comment: 'updated' },
      });
    });

    it('an explicit null comment clears it', async () => {
      prisma.orderFeedback.findFirst.mockResolvedValue(feedbackFixture({ comment: 'existing' }));
      prisma.orderFeedback.update.mockResolvedValue(feedbackFixture({ comment: null }));

      await service.updateOrderFeedback('user-1', 'feedback-1', { comment: null });

      expect(prisma.orderFeedback.update).toHaveBeenCalledWith({
        where: { id: 'feedback-1' },
        data: { comment: null },
      });
    });

    it('an empty-string comment clears it', async () => {
      prisma.orderFeedback.findFirst.mockResolvedValue(feedbackFixture({ comment: 'existing' }));
      prisma.orderFeedback.update.mockResolvedValue(feedbackFixture({ comment: null }));

      await service.updateOrderFeedback('user-1', 'feedback-1', { comment: '' });

      expect(prisma.orderFeedback.update).toHaveBeenCalledWith({
        where: { id: 'feedback-1' },
        data: { comment: null },
      });
    });

    it('a whitespace-only comment clears it', async () => {
      prisma.orderFeedback.findFirst.mockResolvedValue(feedbackFixture({ comment: 'existing' }));
      prisma.orderFeedback.update.mockResolvedValue(feedbackFixture({ comment: null }));

      await service.updateOrderFeedback('user-1', 'feedback-1', { comment: '   ' });

      expect(prisma.orderFeedback.update).toHaveBeenCalledWith({
        where: { id: 'feedback-1' },
        data: { comment: null },
      });
    });

    it("rejects editing another customer's feedback as not found", async () => {
      prisma.orderFeedback.findFirst.mockResolvedValue(null);

      await expect(
        service.updateOrderFeedback('user-2', 'feedback-1', { rating: 2 }),
      ).rejects.toMatchObject({
        constructor: NotFoundException,
        response: { code: 'ORDER_FEEDBACK_NOT_FOUND' },
      });
      expect(prisma.orderFeedback.update).not.toHaveBeenCalled();
    });

    it('never accepts orderId/userId — UpdateOrderFeedbackDto only exposes rating/comment', async () => {
      prisma.orderFeedback.findFirst.mockResolvedValue(feedbackFixture());
      prisma.orderFeedback.update.mockResolvedValue(feedbackFixture({ rating: 3 }));

      await service.updateOrderFeedback('user-1', 'feedback-1', { rating: 3, comment: 'x' });

      const dataArg = prisma.orderFeedback.update.mock.calls[0][0].data;
      expect(Object.keys(dataArg).sort()).toEqual(['comment', 'rating']);
    });
  });
});
