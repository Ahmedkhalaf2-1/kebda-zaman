import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PricingService, resolveMenuItemPrice } from './pricing.service';
import { PrismaService } from '../../prisma/prisma.service';

const D = (v: string | number) => new Prisma.Decimal(v);

describe('resolveMenuItemPrice — Menu Item sale price', () => {
  it('returns basePrice when salePrice is null (no discount)', () => {
    const price = resolveMenuItemPrice({ basePrice: D('20.00'), salePrice: null });
    expect(price.toString()).toBe('20');
  });

  it('returns salePrice when it is valid (> 0 and < basePrice)', () => {
    const price = resolveMenuItemPrice({ basePrice: D('20.00'), salePrice: D('15.00') });
    expect(price.toString()).toBe('15');
  });

  it('falls back to basePrice when salePrice equals basePrice (defensive, should never occur post-validation)', () => {
    const price = resolveMenuItemPrice({ basePrice: D('20.00'), salePrice: D('20.00') });
    expect(price.toString()).toBe('20');
  });

  it('falls back to basePrice when salePrice exceeds basePrice (defensive)', () => {
    const price = resolveMenuItemPrice({ basePrice: D('20.00'), salePrice: D('25.00') });
    expect(price.toString()).toBe('20');
  });

  it('falls back to basePrice when salePrice is zero (defensive)', () => {
    const price = resolveMenuItemPrice({ basePrice: D('20.00'), salePrice: D('0') });
    expect(price.toString()).toBe('20');
  });

  it('falls back to basePrice when salePrice is negative (defensive)', () => {
    const price = resolveMenuItemPrice({ basePrice: D('20.00'), salePrice: D('-5.00') });
    expect(price.toString()).toBe('20');
  });
});

/** Minimal PromoCode fixture — only the fields evaluatePromo reads. */
function makePromo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'promo-1',
    code: 'SAVE10',
    discountType: 'PERCENT',
    value: D(10),
    minOrderAmount: null,
    maxDiscountAmount: null,
    maxUsage: null,
    usageCount: 0,
    perUserLimit: 1,
    startsAt: null,
    expiresAt: null,
    isActive: true,
    deletedAt: null,
    ...overrides,
  };
}

describe('PricingService.evaluatePromo — per-user usage limit', () => {
  let prisma: {
    promoCode: { findFirst: jest.Mock };
    order: { count: jest.Mock };
  };
  let service: PricingService;

  beforeEach(() => {
    prisma = {
      promoCode: { findFirst: jest.fn() },
      order: { count: jest.fn() },
    };
    service = new PricingService(prisma as unknown as PrismaService);
  });

  it('allows a new customer (no prior orders against this promo) to apply it', async () => {
    prisma.promoCode.findFirst.mockResolvedValue(makePromo({ perUserLimit: 1 }));
    prisma.order.count.mockResolvedValue(0);

    const result = await service.evaluatePromo('SAVE10', D('100.00'), 'user-new');

    expect(result.discount.toString()).toBe('10');
    expect(prisma.order.count).toHaveBeenCalledWith({
      where: { userId: 'user-new', appliedPromoId: 'promo-1' },
    });
  });

  it('rejects a customer who already has one prior order against this promo when perUserLimit is 1', async () => {
    prisma.promoCode.findFirst.mockResolvedValue(makePromo({ perUserLimit: 1 }));
    prisma.order.count.mockResolvedValue(1);

    await expect(service.evaluatePromo('SAVE10', D('100.00'), 'user-a')).rejects.toMatchObject({
      response: { code: 'PROMO_ALREADY_USED', message: 'You have already used this promo code' },
    });
    await expect(service.evaluatePromo('SAVE10', D('100.00'), 'user-a')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('treats a null perUserLimit as 1 (one-use-per-customer with no DB backfill)', async () => {
    prisma.promoCode.findFirst.mockResolvedValue(makePromo({ perUserLimit: null }));
    prisma.order.count.mockResolvedValue(1);

    await expect(service.evaluatePromo('SAVE10', D('100.00'), 'user-a')).rejects.toMatchObject({
      response: { code: 'PROMO_ALREADY_USED' },
    });
  });

  it('perUserLimit = 2 allows the first two uses and rejects a third attempt', async () => {
    prisma.promoCode.findFirst.mockResolvedValue(makePromo({ perUserLimit: 2 }));

    prisma.order.count.mockResolvedValue(0);
    await expect(service.evaluatePromo('SAVE10', D('100.00'), 'user-a')).resolves.toBeDefined();

    prisma.order.count.mockResolvedValue(1);
    await expect(service.evaluatePromo('SAVE10', D('100.00'), 'user-a')).resolves.toBeDefined();

    prisma.order.count.mockResolvedValue(2);
    await expect(service.evaluatePromo('SAVE10', D('100.00'), 'user-a')).rejects.toMatchObject({
      response: { code: 'PROMO_ALREADY_USED' },
    });
  });

  it('does not let customer A using the code block customer B from using it', async () => {
    prisma.promoCode.findFirst.mockResolvedValue(makePromo({ perUserLimit: 1 }));
    prisma.order.count.mockImplementation(({ where }: { where: { userId: string } }) =>
      Promise.resolve(where.userId === 'user-a' ? 1 : 0),
    );

    await expect(service.evaluatePromo('SAVE10', D('100.00'), 'user-a')).rejects.toMatchObject({
      response: { code: 'PROMO_ALREADY_USED' },
    });
    await expect(service.evaluatePromo('SAVE10', D('100.00'), 'user-b')).resolves.toBeDefined();
  });

  it('leaves the global maxUsage check unchanged — a fully-redeemed promo is rejected before the per-user check', async () => {
    prisma.promoCode.findFirst.mockResolvedValue(
      makePromo({ maxUsage: 5, usageCount: 5, perUserLimit: 10 }),
    );
    prisma.order.count.mockResolvedValue(0);

    await expect(service.evaluatePromo('SAVE10', D('100.00'), 'user-new')).rejects.toMatchObject({
      response: { code: 'PROMO_INVALID' },
    });
  });
});
