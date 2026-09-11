import { CatalogService } from './catalog.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ReviewsService } from '../reviews/reviews.service';

/** Verifies the catalog <-> reviews rating integration never turns into a per-item query (plan RATINGS_REVIEWS_API_CONTRACT §Catalog integration). */
describe('CatalogService — rating aggregate integration', () => {
  function menuItemFixture(id: string) {
    return {
      id,
      categoryId: 'cat-1',
      nameAr: 'ar',
      nameEn: 'en',
      descriptionAr: 'd',
      descriptionEn: 'd',
      basePrice: { toNumber: () => 10 },
      salePrice: null,
      calories: null,
      compareAtPrice: null,
      imageUrl: null,
      isAvailable: true,
      isPopular: false,
      badge: null,
      variants: [],
      addonGroups: [],
    };
  }

  let prisma: {
    menuItem: { findMany: jest.Mock; findFirst: jest.Mock };
    menuItemRecommendation: { findMany: jest.Mock };
  };
  let reviewsService: {
    getMenuItemRatingAggregates: jest.Mock;
    getMenuItemRatingSummary: jest.Mock;
  };
  let service: CatalogService;

  beforeEach(() => {
    prisma = {
      menuItem: { findMany: jest.fn(), findFirst: jest.fn() },
      menuItemRecommendation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    reviewsService = {
      getMenuItemRatingAggregates: jest.fn().mockResolvedValue(new Map()),
      getMenuItemRatingSummary: jest
        .fn()
        .mockResolvedValue({ averageRating: 0, reviewCount: 0, distribution: {} }),
    };
    service = new CatalogService(
      prisma as unknown as PrismaService,
      reviewsService as unknown as ReviewsService,
    );
  });

  it('fetches ratings for a page of list items with exactly ONE batched call, not one per item', async () => {
    prisma.menuItem.findMany.mockResolvedValue([
      menuItemFixture('item-1'),
      menuItemFixture('item-2'),
      menuItemFixture('item-3'),
    ]);
    reviewsService.getMenuItemRatingAggregates.mockResolvedValue(
      new Map([
        ['item-1', { averageRating: 4.8, reviewCount: 327 }],
        ['item-2', { averageRating: 3.2, reviewCount: 5 }],
      ]),
    );

    const result = await service.listMenuItems({});

    expect(reviewsService.getMenuItemRatingAggregates).toHaveBeenCalledTimes(1);
    expect(reviewsService.getMenuItemRatingAggregates).toHaveBeenCalledWith([
      'item-1',
      'item-2',
      'item-3',
    ]);
    expect(result[0]).toMatchObject({ averageRating: 4.8, reviewCount: 327 });
    expect(result[1]).toMatchObject({ averageRating: 3.2, reviewCount: 5 });
    // item-3 has no reviews at all -> zeroed defaults, not undefined/omitted
    expect(result[2]).toMatchObject({ averageRating: 0, reviewCount: 0 });
  });

  it('menu item detail includes the single-item rating summary', async () => {
    prisma.menuItem.findFirst.mockResolvedValue(menuItemFixture('item-1'));
    reviewsService.getMenuItemRatingSummary.mockResolvedValue({
      averageRating: 4.5,
      reviewCount: 12,
      distribution: { '1': 0, '2': 0, '3': 0, '4': 6, '5': 6 },
    });

    const result = await service.getMenuItem('item-1');

    expect(reviewsService.getMenuItemRatingSummary).toHaveBeenCalledWith('item-1');
    expect(result).toMatchObject({ averageRating: 4.5, reviewCount: 12 });
  });
});
