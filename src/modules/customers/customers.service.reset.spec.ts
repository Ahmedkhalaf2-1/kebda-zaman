import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { CustomersService } from './customers.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Admin "wipe customers" feature — keeps every customer's User row (account
 * + login) untouched; only loyalty points/ledger and reviews are cleared,
 * scoped to CUSTOMER-role users, independent of order-reset.
 */
describe('CustomersService — admin data reset', () => {
  let prisma: {
    loyaltyAccount: { aggregate: jest.Mock; updateMany: jest.Mock };
    loyaltyTransaction: { count: jest.Mock; deleteMany: jest.Mock };
    itemReview: { count: jest.Mock; deleteMany: jest.Mock };
    orderFeedback: { count: jest.Mock; deleteMany: jest.Mock };
    user: { update: jest.Mock; deleteMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let config: { get: jest.Mock };
  let service: CustomersService;

  const customerScope = { user: { role: UserRole.CUSTOMER } };

  beforeEach(() => {
    prisma = {
      loyaltyAccount: { aggregate: jest.fn(), updateMany: jest.fn() },
      loyaltyTransaction: { count: jest.fn(), deleteMany: jest.fn() },
      itemReview: { count: jest.fn(), deleteMany: jest.fn() },
      orderFeedback: { count: jest.fn(), deleteMany: jest.fn() },
      user: { update: jest.fn(), deleteMany: jest.fn() },
      $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
    };
    config = { get: jest.fn().mockReturnValue('development') };
    service = new CustomersService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  describe('resetPreview', () => {
    it('returns counts scoped to CUSTOMER users, without changing anything', async () => {
      prisma.loyaltyAccount.aggregate.mockResolvedValue({
        _count: { _all: 12 },
        _sum: { pointsBalance: 340 },
      });
      prisma.loyaltyTransaction.count.mockResolvedValue(56);
      prisma.itemReview.count.mockResolvedValue(9);
      prisma.orderFeedback.count.mockResolvedValue(4);

      const preview = await service.resetPreview();

      expect(preview).toEqual({
        loyaltyAccounts: 12,
        pointsCleared: 340,
        transactions: 56,
        reviews: 9,
        feedback: 4,
      });
      expect(prisma.loyaltyAccount.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({ where: customerScope }),
      );
      expect(prisma.itemReview.deleteMany).not.toHaveBeenCalled();
    });

    it('reports zero points to clear when no loyalty accounts exist', async () => {
      prisma.loyaltyAccount.aggregate.mockResolvedValue({
        _count: { _all: 0 },
        _sum: { pointsBalance: null },
      });
      prisma.loyaltyTransaction.count.mockResolvedValue(0);
      prisma.itemReview.count.mockResolvedValue(0);
      prisma.orderFeedback.count.mockResolvedValue(0);

      const preview = await service.resetPreview();

      expect(preview.pointsCleared).toBe(0);
    });
  });

  describe('resetCustomerData', () => {
    it('zeroes loyalty points, deletes the ledger and reviews — never touches User rows', async () => {
      prisma.loyaltyAccount.aggregate.mockResolvedValue({
        _count: { _all: 3 },
        _sum: { pointsBalance: 50 },
      });
      prisma.loyaltyTransaction.count.mockResolvedValue(7);
      prisma.itemReview.count.mockResolvedValue(2);
      prisma.orderFeedback.count.mockResolvedValue(1);

      await service.resetCustomerData();

      expect(prisma.loyaltyTransaction.deleteMany).toHaveBeenCalledWith({
        where: { account: customerScope },
      });
      expect(prisma.loyaltyAccount.updateMany).toHaveBeenCalledWith({
        where: customerScope,
        data: { pointsBalance: 0 },
      });
      expect(prisma.itemReview.deleteMany).toHaveBeenCalledWith({ where: customerScope });
      expect(prisma.orderFeedback.deleteMany).toHaveBeenCalledWith({ where: customerScope });
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.user.deleteMany).not.toHaveBeenCalled();
    });

    it('returns the pre-reset preview counts', async () => {
      prisma.loyaltyAccount.aggregate.mockResolvedValue({
        _count: { _all: 3 },
        _sum: { pointsBalance: 50 },
      });
      prisma.loyaltyTransaction.count.mockResolvedValue(7);
      prisma.itemReview.count.mockResolvedValue(2);
      prisma.orderFeedback.count.mockResolvedValue(1);

      const result = await service.resetCustomerData();

      expect(result).toEqual({
        loyaltyAccounts: 3,
        pointsCleared: 50,
        transactions: 7,
        reviews: 2,
        feedback: 1,
      });
    });

    it('refuses to run in production and never touches the database', async () => {
      config.get.mockReturnValue('production');

      await expect(service.resetCustomerData()).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.loyaltyTransaction.deleteMany).not.toHaveBeenCalled();
      expect(prisma.loyaltyAccount.aggregate).not.toHaveBeenCalled();
    });
  });
});
