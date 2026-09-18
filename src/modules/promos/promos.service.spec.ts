import { Prisma } from '@prisma/client';
import { PromosService } from './promos.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CartService } from '../cart/cart.service';
import { PricingService } from '../pricing/pricing.service';
import { PromoDto } from './dto/promo.dto';

function makeDto(overrides: Partial<PromoDto> = {}): PromoDto {
  return {
    code: 'SAVE10',
    discountType: 'PERCENT',
    value: 10,
    ...overrides,
  } as PromoDto;
}

describe('PromosService — admin perUserLimit handling', () => {
  let prisma: {
    promoCode: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  };
  let service: PromosService;

  beforeEach(() => {
    const toDecimalFields = (data: Record<string, unknown>) => ({
      ...data,
      value: new Prisma.Decimal(data.value as number),
      minOrderAmount:
        data.minOrderAmount != null ? new Prisma.Decimal(data.minOrderAmount as number) : null,
      maxDiscountAmount:
        data.maxDiscountAmount != null
          ? new Prisma.Decimal(data.maxDiscountAmount as number)
          : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma = {
      promoCode: {
        findFirst: jest.fn().mockResolvedValue(null), // no existing code collision
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'promo-1', ...toDecimalFields(data) }),
          ),
        update: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'promo-1', ...toDecimalFields(data) }),
          ),
      },
    };
    service = new PromosService(
      prisma as unknown as PrismaService,
      {} as CartService,
      {} as PricingService,
    );
  });

  it('defaults perUserLimit to 1 on create when the admin omits it', async () => {
    await service.create(makeDto());

    expect(prisma.promoCode.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ perUserLimit: 1 }) }),
    );
  });

  it('preserves an explicit admin-supplied perUserLimit on create', async () => {
    await service.create(makeDto({ perUserLimit: 3 }));

    expect(prisma.promoCode.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ perUserLimit: 3 }) }),
    );
  });

  it('preserves the existing perUserLimit on update when the admin omits it from the payload', async () => {
    prisma.promoCode.findFirst.mockResolvedValue({
      id: 'promo-1',
      code: 'SAVE10',
      perUserLimit: 2,
      isActive: true,
    });

    await service.update('promo-1', makeDto());

    expect(prisma.promoCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ perUserLimit: 2 }) }),
    );
  });

  it('overwrites perUserLimit on update when the admin supplies an explicit value', async () => {
    prisma.promoCode.findFirst.mockResolvedValue({
      id: 'promo-1',
      code: 'SAVE10',
      perUserLimit: 2,
      isActive: true,
    });

    await service.update('promo-1', makeDto({ perUserLimit: 5 }));

    expect(prisma.promoCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ perUserLimit: 5 }) }),
    );
  });
});
