import { ReviewsService } from './reviews.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('ReviewsService — admin list filters/pagination', () => {
  let prisma: {
    itemReview: { findMany: jest.Mock };
    orderFeedback: { findMany: jest.Mock };
  };
  let service: ReviewsService;

  beforeEach(() => {
    prisma = {
      itemReview: { findMany: jest.fn().mockResolvedValue([]) },
      orderFeedback: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new ReviewsService(prisma as unknown as PrismaService);
  });

  it('applies rating/menuItemId/orderId/userId filters and default pagination', async () => {
    await service.adminListItemReviews({
      rating: 5,
      menuItemId: 'menu-1',
      orderId: 'order-1',
      userId: 'user-1',
    });

    expect(prisma.itemReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          rating: 5,
          menuItemId: 'menu-1',
          orderId: 'order-1',
          userId: 'user-1',
        }),
        skip: 0,
        take: 20,
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('applies page/limit to skip/take', async () => {
    await service.adminListItemReviews({ page: 3, limit: 10 });

    expect(prisma.itemReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
  });

  it('applies a from/to createdAt range', async () => {
    await service.adminListItemReviews({ from: '2026-01-01', to: '2026-01-31' });

    const where = prisma.itemReview.findMany.mock.calls[0][0].where;
    expect(where.createdAt.gte).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(where.createdAt.lte).toEqual(new Date('2026-01-31T23:59:59.999Z'));
  });

  it('lists order feedback with rating/orderId/userId filters (no menuItemId)', async () => {
    await service.adminListOrderFeedback({ rating: 2, orderId: 'order-1', userId: 'user-1' });

    expect(prisma.orderFeedback.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ rating: 2, orderId: 'order-1', userId: 'user-1' }),
      }),
    );
  });
});
