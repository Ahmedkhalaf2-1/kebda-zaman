import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { LoyaltyAccount, LoyaltyTransaction, Order, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedeemDto } from './dto/redeem.dto';

export interface LoyaltyAccountResponseDto {
  id: string;
  userId: string;
  pointsBalance: number;
  createdAt: string;
  updatedAt: string;
}

export interface LoyaltyTransactionResponseDto {
  id: string;
  delta: number;
  reason: string;
  orderId: string | null;
  createdAt: string;
}

export interface LoyaltyReward {
  id: string;
  name: string;
  pointsCost: number;
}

function toAccountResponse(account: LoyaltyAccount): LoyaltyAccountResponseDto {
  return {
    id: account.id,
    userId: account.userId,
    pointsBalance: account.pointsBalance,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

function toTransactionResponse(transaction: LoyaltyTransaction): LoyaltyTransactionResponseDto {
  return {
    id: transaction.id,
    delta: transaction.delta,
    reason: transaction.reason,
    orderId: transaction.orderId,
    createdAt: transaction.createdAt.toISOString(),
  };
}

/**
 * No redemption catalog is specified by the plan beyond "static/config
 * initially" (§2.16) — a small fixed in-code catalog stands in until a real
 * rewards system is designed.
 */
export const LOYALTY_REWARDS: LoyaltyReward[] = [
  { id: 'free-delivery', name: 'Free Delivery', pointsCost: 100 },
  { id: 'discount-10', name: '10 off your next order', pointsCost: 150 },
  { id: 'discount-25', name: '25 off your next order', pointsCost: 350 },
];

/** 1 point per 10 currency units spent, floored — a documented default policy (plan is silent on the exact rate). */
const CURRENCY_UNITS_PER_POINT = 10;
const ORDER_EARNED_REASON = 'ORDER_EARNED';
const REDEMPTION_REASON = 'REDEMPTION';

@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getAccount(userId: string): Promise<LoyaltyAccountResponseDto> {
    const account = await this.getOrCreateAccount(userId);
    return toAccountResponse(account);
  }

  async listTransactions(userId: string): Promise<LoyaltyTransactionResponseDto[]> {
    const account = await this.getOrCreateAccount(userId);
    const transactions = await this.prisma.loyaltyTransaction.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: 'desc' },
    });
    return transactions.map(toTransactionResponse);
  }

  async redeem(
    userId: string,
    dto: RedeemDto,
  ): Promise<{ account: LoyaltyAccountResponseDto; redemption: Record<string, unknown> }> {
    const reward = LOYALTY_REWARDS.find((r) => r.id === dto.rewardId);
    if (!reward) {
      throw new NotFoundException({ message: 'Unknown reward', code: 'REWARD_NOT_FOUND' });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const account = await tx.loyaltyAccount.upsert({
        where: { userId },
        update: {},
        create: { userId },
      });
      if (account.pointsBalance < reward.pointsCost) {
        throw new UnprocessableEntityException({
          message: 'Insufficient loyalty points',
          code: 'INSUFFICIENT_POINTS',
        });
      }
      const updatedAccount = await tx.loyaltyAccount.update({
        where: { id: account.id },
        data: { pointsBalance: { decrement: reward.pointsCost } },
      });
      const transaction = await tx.loyaltyTransaction.create({
        data: {
          accountId: account.id,
          delta: -reward.pointsCost,
          reason: REDEMPTION_REASON,
        },
      });
      return { updatedAccount, transaction };
    });

    return {
      account: toAccountResponse(result.updatedAccount),
      redemption: {
        rewardId: reward.id,
        rewardName: reward.name,
        pointsCost: reward.pointsCost,
        transactionId: result.transaction.id,
        redeemedAt: result.transaction.createdAt.toISOString(),
      },
    };
  }

  /**
   * Order-completion earning (plan §9 DoD). Called after an order's DELIVERED
   * transition commits (OrdersService). Guests never accrue points; the
   * `(orderId, reason)` unique constraint makes a second call for the same
   * order a no-op instead of double-crediting.
   */
  async earnForOrder(order: Order): Promise<void> {
    if (order.status !== 'DELIVERED') {
      return;
    }
    const user = await this.prisma.user.findUnique({ where: { id: order.userId } });
    if (!user || user.isGuest) {
      return;
    }
    const points = Math.floor(order.totalAmount.toNumber() / CURRENCY_UNITS_PER_POINT);
    if (points <= 0) {
      return;
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const account = await tx.loyaltyAccount.upsert({
          where: { userId: order.userId },
          update: {},
          create: { userId: order.userId },
        });
        await tx.loyaltyTransaction.create({
          data: {
            accountId: account.id,
            delta: points,
            reason: ORDER_EARNED_REASON,
            orderId: order.id,
          },
        });
        await tx.loyaltyAccount.update({
          where: { id: account.id },
          data: { pointsBalance: { increment: points } },
        });
      });
    } catch (error) {
      if (this.isDuplicateAward(error)) {
        this.logger.debug(`Loyalty points already awarded for order ${order.id} — skipping`);
        return;
      }
      throw error;
    }
  }

  private async getOrCreateAccount(userId: string): Promise<LoyaltyAccount> {
    return this.prisma.loyaltyAccount.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
  }

  private isDuplicateAward(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}

/** Guests are excluded up front by role-gating in the controller; this mirrors that intent for direct service callers. */
export function assertNotGuest(isGuest: boolean): void {
  if (isGuest) {
    throw new ForbiddenException({
      message: 'Guest accounts are not eligible for loyalty benefits',
      code: 'GUEST_NOT_ELIGIBLE',
    });
  }
}
