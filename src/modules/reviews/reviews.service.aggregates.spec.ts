import { ReviewsService } from './reviews.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('ReviewsService — rating aggregates', () => {
  let prisma: {
    itemReview: { groupBy: jest.Mock; findMany: jest.Mock };
    orderFeedback: { aggregate: jest.Mock; findMany: jest.Mock };
    menuItem: { findMany: jest.Mock };
  };
  let service: ReviewsService;

  beforeEach(() => {
    prisma = {
      itemReview: { groupBy: jest.fn(), findMany: jest.fn() },
      orderFeedback: { aggregate: jest.fn(), findMany: jest.fn() },
      menuItem: { findMany: jest.fn() },
    };
    service = new ReviewsService(prisma as unknown as PrismaService);
  });

  describe('getMenuItemRatingSummary', () => {
    it('computes average (rounded to 2 decimals), count, and the 1-5 distribution', async () => {
      prisma.itemReview.groupBy.mockResolvedValue([
        { rating: 5, _count: { _all: 2 } },
        { rating: 4, _count: { _all: 1 } },
        { rating: 3, _count: { _all: 0 } },
      ]);

      const summary = await service.getMenuItemRatingSummary('menu-item-1');

      // (5*2 + 4*1) / 3 = 4.666... -> 4.67
      expect(summary.averageRating).toBe(4.67);
      expect(summary.reviewCount).toBe(3);
      expect(summary.distribution).toEqual({ '1': 0, '2': 0, '3': 0, '4': 1, '5': 2 });
    });

    it('returns zero average/count for a menu item with no reviews', async () => {
      prisma.itemReview.groupBy.mockResolvedValue([]);

      const summary = await service.getMenuItemRatingSummary('menu-item-1');

      expect(summary).toEqual({
        averageRating: 0,
        reviewCount: 0,
        distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
      });
    });
  });

  describe('getMenuItemRatingAggregates (batched, no N+1)', () => {
    it('issues exactly one groupBy query for the whole page of menu items', async () => {
      prisma.itemReview.groupBy.mockResolvedValue([
        { menuItemId: 'item-1', _avg: { rating: 4.5 }, _count: { _all: 2 } },
        { menuItemId: 'item-2', _avg: { rating: 3 }, _count: { _all: 1 } },
      ]);

      const result = await service.getMenuItemRatingAggregates(['item-1', 'item-2', 'item-3']);

      expect(prisma.itemReview.groupBy).toHaveBeenCalledTimes(1);
      expect(result.get('item-1')).toEqual({ averageRating: 4.5, reviewCount: 2 });
      expect(result.get('item-2')).toEqual({ averageRating: 3, reviewCount: 1 });
      expect(result.has('item-3')).toBe(false);
    });

    it('skips the query entirely for an empty id list', async () => {
      const result = await service.getMenuItemRatingAggregates([]);

      expect(prisma.itemReview.groupBy).not.toHaveBeenCalled();
      expect(result.size).toBe(0);
    });
  });

  describe('adminSummary', () => {
    it('excludes menu items below the ranking threshold and sorts deterministically', async () => {
      prisma.itemReview.groupBy
        // itemReviews overall distribution
        .mockResolvedValueOnce([
          { rating: 5, _count: { _all: 10 } },
          { rating: 1, _count: { _all: 2 } },
        ])
        // topRated ranking pass
        .mockResolvedValueOnce([
          { menuItemId: 'below-threshold', _avg: { rating: 5 }, _count: { _all: 2 } }, // only 2 reviews — excluded
          { menuItemId: 'item-a', _avg: { rating: 4.5 }, _count: { _all: 5 } },
          { menuItemId: 'item-b', _avg: { rating: 4.5 }, _count: { _all: 8 } }, // tie on rating, wins on count
        ])
        // lowestRated ranking pass
        .mockResolvedValueOnce([
          { menuItemId: 'below-threshold', _avg: { rating: 5 }, _count: { _all: 2 } },
          { menuItemId: 'item-a', _avg: { rating: 4.5 }, _count: { _all: 5 } },
          { menuItemId: 'item-b', _avg: { rating: 4.5 }, _count: { _all: 8 } },
        ]);
      prisma.orderFeedback.aggregate.mockResolvedValue({
        _avg: { rating: 4.2 },
        _count: { _all: 10 },
      });
      prisma.menuItem.findMany.mockResolvedValue([
        { id: 'item-a', nameAr: 'a-ar', nameEn: 'a-en', imageUrl: null },
        { id: 'item-b', nameAr: 'b-ar', nameEn: 'b-en', imageUrl: null },
      ]);

      const summary = await service.adminSummary();

      expect(summary.itemReviews).toEqual({ averageRating: 4.33, reviewCount: 12 });
      expect(summary.orderFeedback).toEqual({ averageRating: 4.2, reviewCount: 10 });
      // item-b ties item-a on rating but has more reviews -> ranked first
      expect(summary.topRatedItems.map((i) => i.menuItemId)).toEqual(['item-b', 'item-a']);
      expect(summary.topRatedItems.every((i) => i.menuItemId !== 'below-threshold')).toBe(true);
      expect(summary.lowestRatedItems.every((i) => i.menuItemId !== 'below-threshold')).toBe(true);
    });

    it('returns empty top/lowest lists when no menu item meets the review-count threshold', async () => {
      prisma.itemReview.groupBy
        .mockResolvedValueOnce([]) // overall distribution
        .mockResolvedValueOnce([{ menuItemId: 'item-a', _avg: { rating: 5 }, _count: { _all: 1 } }])
        .mockResolvedValueOnce([
          { menuItemId: 'item-a', _avg: { rating: 5 }, _count: { _all: 1 } },
        ]);
      prisma.orderFeedback.aggregate.mockResolvedValue({
        _avg: { rating: null },
        _count: { _all: 0 },
      });

      const summary = await service.adminSummary();

      expect(summary.topRatedItems).toEqual([]);
      expect(summary.lowestRatedItems).toEqual([]);
      expect(summary.orderFeedback).toEqual({ averageRating: 0, reviewCount: 0 });
      expect(prisma.menuItem.findMany).not.toHaveBeenCalled();
    });
  });
});
