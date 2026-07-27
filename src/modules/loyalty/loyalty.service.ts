import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DeliveryMethod, LoyaltyAccount, LoyaltyTransaction, Order, Prisma } from '@prisma/client';
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
  rewardId: string | null;
  createdAt: string;
}

/** Discriminated effect so redemption logic never has to string-match a reward's opaque `id`. */
export type LoyaltyRewardEffect =
  { type: 'FREE_DELIVERY' } | { type: 'FIXED_DISCOUNT'; amount: number };

export interface LoyaltyReward {
  id: string;
  name: string;
  pointsCost: number;
  effect: LoyaltyRewardEffect;
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
    rewardId: transaction.rewardId,
    createdAt: transaction.createdAt.toISOString(),
  };
}

/**
 * No redemption catalog is specified by the plan beyond "static/config
 * initially" (§2.16) — a small fixed in-code catalog stands in until a real
 * rewards system is designed. `effect` is what `evaluateRedemption` actually
 * acts on; `id` is only a stable, opaque lookup key used on the wire.
 */
export const LOYALTY_REWARDS: LoyaltyReward[] = [
  {
    id: 'free-delivery',
    name: 'Free Delivery',
    pointsCost: 100,
    effect: { type: 'FREE_DELIVERY' },
  },
  {
    id: 'discount-10',
    name: '10 off your next order',
    pointsCost: 150,
    effect: { type: 'FIXED_DISCOUNT', amount: 10 },
  },
  {
    id: 'discount-25',
    name: '25 off your next order',
    pointsCost: 350,
    effect: { type: 'FIXED_DISCOUNT', amount: 25 },
  },
];

/** 1 point per 10 currency units spent, floored — a documented default policy (plan is silent on the exact rate). */
const CURRENCY_UNITS_PER_POINT = 10;
const ORDER_EARNED_REASON = 'ORDER_EARNED';
/** Exported so callers building a LoyaltyTransaction query (e.g. OrdersService, to look up a checkout's redemption) never re-type this literal. */
export const LOYALTY_REDEMPTION_REASON = 'REDEMPTION';

export interface LoyaltyRedemptionEvaluation {
  reward: LoyaltyReward;
  /** Amount to subtract from the order subtotal — always 0 for a delivery-fee waiver. */
  discount: Prisma.Decimal;
  /** True only for a reward whose effect zeroes the delivery fee. */
  waivesDeliveryFee: boolean;
}

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

  /**
   * LEGACY / MANUAL redemption path. Kept only for backward compatibility
   * with existing frontend clients calling `POST /me/loyalty/redeem`
   * standalone, outside of checkout (`orderId` on the resulting ledger row
   * is always `null`). For any *new* flow that ties a redemption to an order
   * — e.g. checkout, see `OrdersService.checkout` — use
   * `evaluateRedemption` + `applyRedemption` directly instead of this
   * method, so the redemption commits or rolls back atomically with the
   * rest of that flow. This method is intentionally just a thin wrapper
   * over those same two building blocks: the balance-check/decrement/ledger
   * logic itself is never duplicated.
   */
  async redeem(
    userId: string,
    dto: RedeemDto,
  ): Promise<{ account: LoyaltyAccountResponseDto; redemption: Record<string, unknown> }> {
    const reward = this.findReward(dto.rewardId);

    const result = await this.prisma.$transaction(async (tx) => {
      const transaction = await this.applyRedemption(tx, userId, reward, null);
      const account = await tx.loyaltyAccount.findUniqueOrThrow({ where: { userId } });
      return { transaction, account };
    });

    return {
      account: toAccountResponse(result.account),
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

  /**
   * Read-only pre-check for a would-be redemption: resolves the reward,
   * confirms the account can currently afford it, confirms the reward is
   * applicable given the order context (a free-delivery reward is
   * meaningless on a PICKUP order), and translates the effect into a plain
   * discount amount / delivery-fee waiver the caller can feed into
   * `PricingService.applyDiscount`. Never mutates anything — safe to call
   * before opening a DB transaction, e.g. to price a cart ahead of checkout.
   *
   * The balance check here can go stale before the caller actually commits
   * (a concurrent redemption on another device) — that's fine by design,
   * `applyRedemption` re-checks it race-safely at commit time.
   */
  async evaluateRedemption(
    userId: string,
    rewardId: string,
    context: { subtotal: Prisma.Decimal; deliveryMethod: DeliveryMethod },
  ): Promise<LoyaltyRedemptionEvaluation> {
    const reward = this.findReward(rewardId);
    const account = await this.getOrCreateAccount(userId);
    if (account.pointsBalance < reward.pointsCost) {
      throw new UnprocessableEntityException({
        message: 'Insufficient loyalty points',
        code: 'INSUFFICIENT_POINTS',
      });
    }

    if (reward.effect.type === 'FREE_DELIVERY') {
      if (context.deliveryMethod !== DeliveryMethod.DELIVERY) {
        throw new UnprocessableEntityException({
          message: 'The free delivery reward only applies to delivery orders',
          code: 'REWARD_NOT_APPLICABLE',
        });
      }
      return { reward, discount: new Prisma.Decimal(0), waivesDeliveryFee: true };
    }

    const discount = Prisma.Decimal.min(reward.effect.amount, context.subtotal);
    return { reward, discount, waivesDeliveryFee: false };
  }

  /**
   * The actual mutation: decrements the account balance and inserts the
   * ledger row. MUST run inside a Prisma transaction the caller controls
   * (`tx`) so it commits or rolls back atomically with whatever else that
   * transaction is doing. `OrdersService.checkout` runs this in the same
   * transaction as order creation and cart clearing, so a failure anywhere
   * in checkout undoes the redemption too — no points are ever lost against
   * an order that didn't actually get created.
   *
   * Race-safe: the balance check and decrement happen in one guarded
   * `updateMany` (`pointsBalance >= pointsCost`), not a separate
   * read-then-write, so two concurrent redemptions for the same account can
   * never both succeed and drive the balance negative. If the guard matches
   * zero rows (balance changed since `evaluateRedemption` ran — e.g. a
   * second device redeemed first), this throws the same `INSUFFICIENT_POINTS`
   * error, which rolls back the caller's whole transaction.
   */
  async applyRedemption(
    tx: Prisma.TransactionClient,
    userId: string,
    reward: LoyaltyReward,
    orderId: string | null,
  ): Promise<LoyaltyTransaction> {
    const account = await tx.loyaltyAccount.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });

    const claimed = await tx.loyaltyAccount.updateMany({
      where: { id: account.id, pointsBalance: { gte: reward.pointsCost } },
      data: { pointsBalance: { decrement: reward.pointsCost } },
    });
    if (claimed.count !== 1) {
      throw new UnprocessableEntityException({
        message: 'Insufficient loyalty points',
        code: 'INSUFFICIENT_POINTS',
      });
    }

    return tx.loyaltyTransaction.create({
      data: {
        accountId: account.id,
        delta: -reward.pointsCost,
        reason: LOYALTY_REDEMPTION_REASON,
        rewardId: reward.id,
        orderId,
      },
    });
  }

  private findReward(rewardId: string): LoyaltyReward {
    const reward = LOYALTY_REWARDS.find((candidate) => candidate.id === rewardId);
    if (!reward) {
      throw new NotFoundException({ message: 'Unknown reward', code: 'REWARD_NOT_FOUND' });
    }
    return reward;
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
