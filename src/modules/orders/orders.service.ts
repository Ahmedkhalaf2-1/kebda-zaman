import { randomBytes, randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeliveryMethod, OrderStatus, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CartService } from '../cart/cart.service';
import { PricingService } from '../pricing/pricing.service';
import { SettingsService } from '../settings/settings.service';
import { DeliveryPricingService } from '../delivery-pricing/delivery-pricing.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import {
  assertNotGuest,
  LOYALTY_REDEMPTION_REASON,
  LOYALTY_REWARDS,
  LoyaltyRedemptionEvaluation,
  LoyaltyService,
} from '../loyalty/loyalty.service';
import { AdminNotificationsService } from '../admin-notifications/admin-notifications.service';
import {
  AdminOrderResponseDto,
  KitchenOrderResponseDto,
  OrderLoyaltyRedemptionDto,
  OrderResponseDto,
  OrderStatusResponseDto,
  toAdminOrderResponse,
  toFrontendStatus,
  toKitchenOrderResponse,
  toOrderResponse,
  toStatusHistoryEntry,
  FRONTEND_STATUS_TO_ORDER_STATUS,
} from '../../common/mappers/order-response.mapper';
import {
  DriverOrderResponseDto,
  DriverOrderWithRelations,
  toDriverOrderHistoryResponse,
  toDriverOrderResponse,
} from '../../common/mappers/driver-order-response.mapper';
import { DeliveryQuoteResult } from '../delivery-pricing/delivery-pricing.service';
import { CheckoutDto } from './dto/checkout.dto';
import { ListOrdersDto } from './dto/list-orders.dto';
import { AdminListOrdersDto } from './dto/admin-list-orders.dto';
import { ListDriverOrdersDto } from './dto/list-driver-orders.dto';

export interface OrdersResetPreviewDto {
  orders: number;
  items: number;
  payments: number;
  reviews: number;
  feedback: number;
}

const orderInclude = {
  user: true,
  items: { include: { customizations: true }, orderBy: { createdAt: 'asc' } },
  // Latest payment only — enough to read authorizedAt for the
  // paymentAuthorizedAt / admin authorization-aging-warning fields.
  payments: { orderBy: { createdAt: 'desc' }, take: 1 },
} satisfies Prisma.OrderInclude;

/** Trimmed include for driver-facing reads — no Payment join (Order already
 * carries paymentMethod/paymentStatus directly) and only the two User fields
 * a driver legitimately needs, never email. */
const driverOrderInclude = {
  user: { select: { fullName: true, phone: true } },
  items: { include: { customizations: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.OrderInclude;

/** A DELIVERY order assigned to a driver is "active" until it reaches a
 * terminal status (DELIVERED/CANCELLED) — assignment can happen as early as
 * PENDING (assignment never itself changes status), so this intentionally
 * covers every non-terminal status, not just OUT_FOR_DELIVERY. */
const DRIVER_ACTIVE_STATUSES: OrderStatus[] = [
  'PENDING',
  'CONFIRMED',
  'PREPARING',
  'OUT_FOR_DELIVERY',
];

/** Completed-delivery history — DELIVERED is the success case; a CANCELLED
 * order that had been assigned is kept visible too (it did happen on this
 * driver's queue) rather than silently vanishing. Both are terminal: a
 * reassigned-away order (driverId no longer matches) is filtered out by the
 * `driverId` clause below regardless of status, matching "previous driver
 * immediately loses access". */
const DRIVER_HISTORY_STATUSES: OrderStatus[] = ['DELIVERED', 'CANCELLED'];

const MAX_ORDER_NUMBER_ATTEMPTS = 5;

/**
 * Forward transitions + cancellation rules (plan §7.5), split per delivery
 * method (Fix 12A) — a DELIVERY order is handed to a courier
 * (OUT_FOR_DELIVERY -> DELIVERED); a PICKUP order is staged at the counter
 * (READY_FOR_PICKUP -> PICKED_UP). The two lifecycles never cross: a PICKUP
 * order can never reach OUT_FOR_DELIVERY/DELIVERED and a DELIVERY order can
 * never reach READY_FOR_PICKUP/PICKED_UP. CANCELLED remains reachable from
 * every non-terminal status in both maps.
 */
const DELIVERY_ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
  READY_FOR_PICKUP: [],
  DELIVERED: [],
  PICKED_UP: [],
  CANCELLED: [],
};

const PICKUP_ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY_FOR_PICKUP', 'CANCELLED'],
  READY_FOR_PICKUP: ['PICKED_UP', 'CANCELLED'],
  OUT_FOR_DELIVERY: [],
  DELIVERED: [],
  PICKED_UP: [],
  CANCELLED: [],
};

/** Method-aware transition resolver — the single source of truth `updateOrderStatus` validates against. */
function getAllowedTransitions(
  deliveryMethod: DeliveryMethod,
  currentStatus: OrderStatus,
): readonly OrderStatus[] {
  return deliveryMethod === 'PICKUP'
    ? PICKUP_ALLOWED_TRANSITIONS[currentStatus]
    : DELIVERY_ALLOWED_TRANSITIONS[currentStatus];
}

/** A completed order — the only statuses that settle payment + earn loyalty (plan §9 DoD, Fix 12A). */
function isTerminalCompletion(status: OrderStatus): boolean {
  return status === 'DELIVERED' || status === 'PICKED_UP';
}

/** Manual kitchen prep time only makes sense while an order is actually in the
 * kitchen preparation phase — `setPreparationTime` rejects every other status
 * (ORDER_NOT_IN_PREPARATION), not just the terminal ones: PENDING hasn't
 * entered the kitchen workflow yet, OUT_FOR_DELIVERY/READY_FOR_PICKUP have
 * already left it, and DELIVERED/PICKED_UP/CANCELLED are terminal. */
const PREPARABLE_ORDER_STATUSES: readonly OrderStatus[] = ['CONFIRMED', 'PREPARING'];

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cartService: CartService,
    private readonly pricingService: PricingService,
    private readonly settingsService: SettingsService,
    private readonly deliveryPricingService: DeliveryPricingService,
    private readonly notificationsService: NotificationsService,
    private readonly paymentsService: PaymentsService,
    private readonly loyaltyService: LoyaltyService,
    private readonly adminNotificationsService: AdminNotificationsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Transactional checkout (plan §6.3/§7.2). Re-runs the full authoritative
   * pricing pass — the client never influences a single money figure. On any
   * failure the transaction rolls back and the cart is left untouched; on
   * success the cart is cleared only inside that same transaction.
   *
   * A customer may use a promo code OR redeem a loyalty reward, never both
   * (`dto.promoCode` and `dto.redeemRewardId` are mutually exclusive — see
   * the guard below). When a reward is redeemed, the point spend
   * (`LoyaltyService.applyRedemption`) runs inside the exact same DB
   * transaction as order creation and cart clearing: if anything else in
   * checkout fails, the whole transaction rolls back, so the points are
   * never spent against an order that doesn't exist.
   */
  async checkout(
    userId: string,
    dto: CheckoutDto,
    idempotencyKeyHeader?: string,
    isGuest = false,
  ): Promise<OrderResponseDto> {
    const namespacedKey = idempotencyKeyHeader
      ? `user:${userId}:${idempotencyKeyHeader}`
      : `auto:${randomUUID()}`;

    if (idempotencyKeyHeader) {
      const existingPayment = await this.prisma.payment.findUnique({
        where: { idempotencyKey: namespacedKey },
        include: { order: { include: orderInclude } },
      });
      if (existingPayment) {
        // A retried request must see the exact same response as the original
        // call, including whether a reward was redeemed — look the ledger
        // entry back up rather than re-running (and re-charging) anything.
        const loyaltyRedemption = await this.findLoyaltyRedemptionForOrder(
          existingPayment.order.id,
        );
        return toOrderResponse(existingPayment.order, loyaltyRedemption);
      }
    }

    if (dto.promoCode && dto.redeemRewardId) {
      throw new UnprocessableEntityException({
        message: 'Use a promo code or redeem a loyalty reward, not both',
        code: 'PROMO_AND_LOYALTY_MUTUALLY_EXCLUSIVE',
      });
    }

    const settings = await this.settingsService.getSettings();
    // Manual gate only (plan Phase 8) — workingHours is informational/display
    // only and never itself blocks checkout. Cart/menu browsing is a
    // different controller entirely and is unaffected by this check.
    if (!settings.acceptingOrders) {
      throw new UnprocessableEntityException({
        message: settings.closedMessageEn || 'The restaurant is not currently accepting orders',
        code: 'RESTAURANT_NOT_ACCEPTING_ORDERS',
        details: {
          closedMessageAr: settings.closedMessageAr,
          closedMessageEn: settings.closedMessageEn,
        },
      });
    }

    if (dto.deliveryMethod === 'DELIVERY' && !dto.deliveryAddress) {
      throw new UnprocessableEntityException({
        message: 'A delivery address is required for delivery orders',
        code: 'DELIVERY_ADDRESS_REQUIRED',
      });
    }

    // Distance-based delivery pricing (VO3, replaces DeliveryZone): the
    // client only ever sends a destination pin — the restaurant origin,
    // travel mode, actual driving distance, matched tier, and every money
    // figure always come from a fresh server-side Google Routes call + DB
    // tier lookup, never from the client. A missing pin or an out-of-range
    // destination both fail checkout before any pricing/DB writes happen.
    let deliveryQuote: DeliveryQuoteResult | null = null;
    if (dto.deliveryMethod === 'DELIVERY') {
      const latitude = dto.deliveryAddress?.latitude;
      const longitude = dto.deliveryAddress?.longitude;
      if (latitude === undefined || longitude === undefined) {
        throw new UnprocessableEntityException({
          message: 'A delivery pin (latitude/longitude) is required for delivery orders',
          code: 'DELIVERY_COORDINATES_REQUIRED',
        });
      }

      deliveryQuote = await this.deliveryPricingService.getAuthoritativeQuote({
        latitude,
        longitude,
      });
      if (!deliveryQuote.deliverable || !deliveryQuote.tier) {
        throw new UnprocessableEntityException({
          message: 'This delivery address is outside the deliverable range',
          code: 'OUTSIDE_DELIVERY_RANGE',
          details: { distanceMeters: deliveryQuote.distanceMeters },
        });
      }
    }

    const { cartId, items, inputs } = await this.cartService.getCartForCheckout(userId);
    if (items.length === 0) {
      throw new ConflictException({ message: 'Cart is empty', code: 'EMPTY_CART' });
    }

    // Authoritative repricing: re-validates every item/variant/addon and the
    // promo from fresh DB reads. Never trusts anything the client sent
    // beyond references+quantities+deliveryMethod+promoCode+deliveryAddress.
    let breakdown = await this.pricingService.priceCart(
      inputs,
      settings,
      dto.deliveryMethod,
      dto.promoCode ?? null,
      deliveryQuote?.tier?.deliveryFee,
      userId,
    );

    // Loyalty redemption is evaluated (read-only) against the freshly-priced
    // subtotal, then layered onto the breakdown through the same totals math
    // `priceCart` itself uses (PricingService.applyDiscount) — never a
    // second, hand-rolled computation. The actual point spend only happens
    // later, inside the DB transaction below.
    let loyaltyEvaluation: LoyaltyRedemptionEvaluation | null = null;
    if (dto.redeemRewardId) {
      assertNotGuest(isGuest);
      loyaltyEvaluation = await this.loyaltyService.evaluateRedemption(userId, dto.redeemRewardId, {
        subtotal: breakdown.subtotal,
        deliveryMethod: dto.deliveryMethod,
      });
      breakdown = this.pricingService.applyDiscount(
        breakdown,
        settings,
        loyaltyEvaluation.discount,
        loyaltyEvaluation.waivesDeliveryFee ? new Prisma.Decimal(0) : undefined,
      );
    }

    // Tier-specific minimum (only when an admin has explicitly set one above
    // 0 — the approved business input defines delivery fees only, so every
    // seeded tier has minimumOrder=0 and this is a no-op in practice;
    // settings.minOrderAmount below remains the authoritative store-wide
    // floor for delivery unless/until an admin configures a tier minimum).
    const tierMinimumOrder = deliveryQuote?.tier?.minimumOrder;
    if (
      tierMinimumOrder &&
      tierMinimumOrder.greaterThan(0) &&
      breakdown.subtotal.lessThan(tierMinimumOrder)
    ) {
      throw new UnprocessableEntityException({
        message: `Minimum order amount of ${tierMinimumOrder.toString()} not met for this delivery tier`,
        code: 'MINIMUM_ORDER_NOT_MET',
        details: { minimumOrder: tierMinimumOrder.toNumber() },
      });
    }

    if (breakdown.subtotal.lessThan(settings.minOrderAmount)) {
      throw new UnprocessableEntityException({
        message: `Minimum order amount of ${settings.minOrderAmount.toString()} not met`,
        code: 'BELOW_MIN_ORDER',
      });
    }

    // Built field-by-field (not a raw spread) so the snapshot shape is
    // stable regardless of what extra properties the DTO carries, and so a
    // missing pin is always an explicit `null` — never defaulted to 0,0
    // (plan VO2.3). Immutable from here on: later edits/deletes of the
    // customer's saved Address never touch this snapshot.
    const addressSnapshot: Prisma.InputJsonValue =
      dto.deliveryMethod === 'DELIVERY' && dto.deliveryAddress
        ? {
            title: dto.deliveryAddress.title,
            street: dto.deliveryAddress.street,
            building: dto.deliveryAddress.building,
            floor: dto.deliveryAddress.floor ?? null,
            apartment: dto.deliveryAddress.apartment ?? null,
            city: dto.deliveryAddress.city,
            latitude: dto.deliveryAddress.latitude ?? null,
            longitude: dto.deliveryAddress.longitude ?? null,
          }
        : { type: 'PICKUP' };

    for (let attempt = 1; attempt <= MAX_ORDER_NUMBER_ATTEMPTS; attempt += 1) {
      const orderNumber = this.generateOrderNumber();
      try {
        const order = await this.prisma.$transaction(
          async (tx) => {
            if (breakdown.promo) {
              // Full re-validation against a fresh, transaction-scoped read —
              // the client may have bypassed cart apply-promo entirely, and
              // eligibility (per-user limit, maxUsage, active window, ...)
              // can have changed since the pricing pass above, including via
              // a second concurrent checkout racing this one.
              await this.pricingService.evaluatePromo(
                breakdown.promo.code,
                breakdown.subtotal,
                userId,
                tx,
              );

              const usageGuard =
                breakdown.promo.maxUsage === null
                  ? {}
                  : { usageCount: { lt: breakdown.promo.maxUsage } };
              const incremented = await tx.promoCode.updateMany({
                where: { id: breakdown.promo.id, deletedAt: null, ...usageGuard },
                data: { usageCount: { increment: 1 } },
              });
              if (incremented.count !== 1) {
                throw new UnprocessableEntityException({
                  message: 'Promo code has been fully redeemed',
                  code: 'PROMO_INVALID',
                });
              }
            }

            const created = await tx.order.create({
              data: {
                orderNumber,
                userId,
                status: 'PENDING',
                subtotal: breakdown.subtotal,
                deliveryFee: breakdown.deliveryFee,
                tax: breakdown.tax,
                discount: breakdown.discount,
                totalAmount: breakdown.totalAmount,
                deliveryMethod: dto.deliveryMethod,
                paymentMethod: dto.paymentMethod,
                paymentStatus: 'PENDING',
                appliedPromoId: breakdown.promo?.id ?? null,
                promoCodeSnapshot: breakdown.promo?.code ?? null,
                deliveryAddressJson: addressSnapshot,
                // deliveryZoneId/deliveryZoneName{Ar,En}Snapshot are deliberately
                // left unset (null) — deprecated, superseded by the snapshot
                // columns below (see the Order model's schema.prisma doc comment).
                deliveryDistanceMeters: deliveryQuote?.distanceMeters ?? null,
                deliveryDurationSeconds: deliveryQuote?.durationSeconds ?? null,
                deliveryTierId: deliveryQuote?.tier?.id ?? null,
                deliveryTierMinKmSnapshot: deliveryQuote?.tier?.minDistanceKm ?? null,
                deliveryTierMaxKmSnapshot: deliveryQuote?.tier?.maxDistanceKm ?? null,
                items: {
                  create: breakdown.lines.map((line, index) => ({
                    menuItemId: line.menuItem.id,
                    quantity: line.quantity,
                    unitPrice: line.unitPrice,
                    lineTotal: line.lineTotal,
                    nameArSnapshot: line.menuItem.nameAr,
                    nameEnSnapshot: line.menuItem.nameEn,
                    imageUrlSnapshot: line.menuItem.imageUrl,
                    specialInstructions: items[index].specialInstructions,
                    customizations: {
                      create: [
                        ...(line.variant
                          ? [
                              {
                                kind: 'VARIANT' as const,
                                refId: line.variant.id,
                                nameArSnapshot: line.variant.nameAr,
                                nameEnSnapshot: line.variant.nameEn,
                                priceSnapshot: line.variant.priceDelta,
                              },
                            ]
                          : []),
                        ...line.addons.map((addon) => ({
                          kind: 'ADDON' as const,
                          refId: addon.id,
                          nameArSnapshot: addon.nameAr,
                          nameEnSnapshot: addon.nameEn,
                          priceSnapshot: addon.price,
                        })),
                      ],
                    },
                  })),
                },
                // `notes` has no dedicated Order column; recorded on the
                // creation history entry, the closest fitting existing field.
                statusHistory: {
                  create: [
                    { toStatus: 'PENDING', changedByUserId: userId, note: dto.notes ?? null },
                  ],
                },
                payments: {
                  create: [
                    {
                      method: dto.paymentMethod,
                      status: 'PENDING',
                      amount: breakdown.totalAmount,
                      currency: breakdown.currency,
                      idempotencyKey: namespacedKey,
                    },
                  ],
                },
              },
              include: orderInclude,
            });

            // Admin Notification Center (Sprint 1): every successfully created
            // order writes one AdminNotification row, in this same transaction —
            // never a separate post-commit step, so it can't be silently missed
            // or left orphaned by a later rollback. The FCM push (Sprint 2) is
            // deliberately NOT sent here — it's best-effort and must never be
            // able to roll back the order, so it fires after commit, below.
            const adminNotification = await this.adminNotificationsService.createForNewOrder(tx, {
              orderId: created.id,
              orderNumber: created.orderNumber,
              customerId: created.userId,
              customerName: created.user.fullName,
              totalAmount: created.totalAmount,
            });

            // Redeems the loyalty reward — same transaction as order creation,
            // so a failure anywhere below (or above) rolls this back too. Runs
            // after order.create specifically so the ledger row can reference
            // the real order id (LoyaltyService.applyRedemption re-checks the
            // balance race-safely; it does not just trust `loyaltyEvaluation`).
            if (loyaltyEvaluation) {
              await this.loyaltyService.applyRedemption(
                tx,
                userId,
                loyaltyEvaluation.reward,
                created.id,
              );
            }

            // Cart is cleared only after the order (and any redemption) is
            // fully created, inside this same transaction — any earlier
            // failure leaves both the cart and the point balance untouched.
            await tx.cartItem.deleteMany({ where: { cartId } });

            return { created, adminNotificationId: adminNotification.id };
          },
          // Serializable: the per-user-limit re-check and the maxUsage-guarded
          // increment above both depend on reads (Order.count / PromoCode.usageCount)
          // that must not be allowed to interleave with a concurrent checkout
          // racing the same promo — Serializable makes Postgres abort one of the
          // two with a P2034 instead of letting both believe they're eligible.
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        // Best-effort admin push (Sprint 2) — fires only after the order and
        // its AdminNotification row are both durably committed. A Firebase
        // failure here is logged and swallowed, never surfaced to the
        // customer and never able to undo the already-committed checkout.
        try {
          await this.notificationsService.sendAdminNewOrderNotification({
            notificationId: order.adminNotificationId,
            orderId: order.created.id,
            orderNumber: order.created.orderNumber,
            customerName: order.created.user.fullName,
          });
        } catch (error) {
          this.logger.warn(
            `Admin push notification failed for order ${order.created.id} (order already committed): ${(error as Error).message}`,
          );
        }

        const loyaltyRedemption: OrderLoyaltyRedemptionDto | null = loyaltyEvaluation
          ? {
              rewardId: loyaltyEvaluation.reward.id,
              rewardName: loyaltyEvaluation.reward.name,
              pointsRedeemed: loyaltyEvaluation.reward.pointsCost,
            }
          : null;
        return toOrderResponse(order.created, loyaltyRedemption);
      } catch (error) {
        if (
          (this.isOrderNumberConflict(error) || this.isSerializationFailure(error)) &&
          attempt < MAX_ORDER_NUMBER_ATTEMPTS
        ) {
          continue;
        }
        throw error;
      }
    }

    throw new InternalServerErrorException({
      message: 'Could not generate a unique order number',
      code: 'ORDER_NUMBER_GENERATION_FAILED',
    });
  }

  /** Reconstructs the loyaltyRedemption response block for an already-created order (idempotent-replay path). */
  private async findLoyaltyRedemptionForOrder(
    orderId: string,
  ): Promise<OrderLoyaltyRedemptionDto | null> {
    const transaction = await this.prisma.loyaltyTransaction.findFirst({
      where: { orderId, reason: LOYALTY_REDEMPTION_REASON },
    });
    const reward = transaction?.rewardId
      ? LOYALTY_REWARDS.find((candidate) => candidate.id === transaction.rewardId)
      : undefined;
    if (!transaction || !reward) {
      return null;
    }
    return { rewardId: reward.id, rewardName: reward.name, pointsRedeemed: -transaction.delta };
  }

  async listOrders(userId: string, query: ListOrdersDto): Promise<OrderResponseDto[]> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const orders = await this.prisma.order.findMany({
      where: {
        userId,
        ...(query.status ? { status: FRONTEND_STATUS_TO_ORDER_STATUS[query.status] } : {}),
      },
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return orders.map((order) => toOrderResponse(order));
  }

  async getOrder(userId: string, orderId: string): Promise<OrderResponseDto> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: orderInclude,
    });
    if (!order) {
      throw new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
    }
    return toOrderResponse(order);
  }

  async getOrderStatus(userId: string, orderId: string): Promise<OrderStatusResponseDto> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { statusHistory: { orderBy: { createdAt: 'asc' } } },
    });
    if (!order) {
      throw new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
    }
    return {
      status: toFrontendStatus(order.status),
      statusHistory: order.statusHistory.map(toStatusHistoryEntry),
      estimatedDeliveryTime: order.estimatedDeliveryTime?.toISOString() ?? null,
    };
  }

  /** ADMIN: every order, optionally filtered by status / free-text search. */
  async adminListOrders(query: AdminListOrdersDto): Promise<AdminOrderResponseDto[]> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const orders = await this.prisma.order.findMany({
      where: {
        ...(query.status ? { status: FRONTEND_STATUS_TO_ORDER_STATUS[query.status] } : {}),
        ...(query.q
          ? {
              OR: [
                { orderNumber: { contains: query.q, mode: 'insensitive' } },
                { user: { fullName: { contains: query.q, mode: 'insensitive' } } },
                { user: { email: { contains: query.q, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return orders.map((order) => toAdminOrderResponse(order));
  }

  /** ADMIN: no ownership restriction — any order. */
  async adminGetOrder(orderId: string): Promise<AdminOrderResponseDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: orderInclude,
    });
    if (!order) {
      throw new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
    }
    return toAdminOrderResponse(order);
  }

  /** Counts for the admin "wipe orders" confirmation dialog — no deletion.
   * Cheap: all indexed counts, no joins. */
  async adminOrdersResetPreview(): Promise<OrdersResetPreviewDto> {
    const [orders, items, payments, reviews, feedback] = await Promise.all([
      this.prisma.order.count(),
      this.prisma.orderItem.count(),
      this.prisma.payment.count(),
      this.prisma.itemReview.count(),
      this.prisma.orderFeedback.count(),
    ]);
    return { orders, items, payments, reviews, feedback };
  }

  /** ADMIN-only, non-production-only (see assertResetAllowed): permanently
   * deletes every Order. Deliberately overrides this codebase's usual "never
   * hard-delete an Order" invariant (see Order's schema doc comment and
   * AuthService.deleteAccount, which anonymizes rather than deletes) — this
   * exists only to clear test/demo data before a real launch, which is why
   * it refuses to run at all once NODE_ENV=production. A single
   * `order.deleteMany` is enough: every dependent row (items, item reviews,
   * order feedback, payments, status/driver-assignment history, driver
   * location) has a DB-level ON DELETE CASCADE back to Order. The one
   * exception is LoyaltyTransaction.orderId, which is a soft reference (no
   * FK) and is intentionally left untouched here — clearing loyalty ledgers
   * is CustomersService.resetCustomerData's job, run independently. */
  async adminResetOrders(): Promise<OrdersResetPreviewDto> {
    this.assertResetAllowed();
    const preview = await this.adminOrdersResetPreview();
    await this.prisma.order.deleteMany({});
    return preview;
  }

  private assertResetAllowed(): void {
    if (this.config.get<string>('nodeEnv') === 'production') {
      throw new ForbiddenException({
        message: 'Data reset is disabled in production',
        code: 'RESET_DISABLED_IN_PRODUCTION',
      });
    }
  }

  /** KITCHEN's live queue — only orders actively being cooked (accepted, not yet
   * handed off). No customer/payment data selected — the read-only ticket view
   * (KitchenOrderResponseDto) never needs it. */
  async kitchenListOrders(): Promise<KitchenOrderResponseDto[]> {
    const orders = await this.prisma.order.findMany({
      where: { status: { in: ['CONFIRMED', 'PREPARING'] } },
      include: { items: { include: { customizations: true }, orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    return orders.map(toKitchenOrderResponse);
  }

  /** Unscoped by status (unlike the list) — a kitchen worker already viewing an
   * order shouldn't hit a 404 just because cashier/admin moved it along
   * mid-view. Still the same trimmed, no-PII/no-payment ticket shape. */
  async kitchenGetOrder(orderId: string): Promise<KitchenOrderResponseDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { customizations: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (!order) {
      throw new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
    }
    return toKitchenOrderResponse(order);
  }

  /**
   * Manual Kitchen Preparation Time / ETA. KITCHEN/ADMIN chooses how many
   * minutes remain until the order is ready — the server clock is
   * authoritative; a frontend-supplied absolute ETA is never accepted. Purely
   * an ETA write: never touches `status` (setting 20 minutes must NOT itself
   * move PENDING -> CONFIRMED or CONFIRMED -> PREPARING), payment
   * capture/void, loyalty, or promo logic.
   *
   * Only usable while the order is actually in the kitchen preparation phase
   * (CONFIRMED/PREPARING) — see PREPARABLE_ORDER_STATUSES.
   *
   * readyAt = now + minutes. For PICKUP, estimatedDeliveryTime = readyAt.
   * For DELIVERY, estimatedDeliveryTime = readyAt + the order's already-
   * authoritative deliveryDurationSeconds (from the Google Routes quote taken
   * at checkout — never re-queried here); if that snapshot is null (only
   * possible for orders placed before distance-pricing was added), readyAt
   * itself is used as the safe ETA rather than failing the request.
   */
  async setPreparationTime(orderId: string, minutes: number): Promise<KitchenOrderResponseDto> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
    }
    if (!PREPARABLE_ORDER_STATUSES.includes(order.status)) {
      throw new UnprocessableEntityException({
        message: `Cannot set preparation time for a ${order.status} order — only CONFIRMED/PREPARING orders are in the kitchen preparation phase`,
        code: 'ORDER_NOT_IN_PREPARATION',
      });
    }

    const now = new Date();
    const readyAt = new Date(now.getTime() + minutes * 60_000);
    const estimatedDeliveryTime =
      order.deliveryMethod === 'DELIVERY' && order.deliveryDurationSeconds !== null
        ? new Date(readyAt.getTime() + order.deliveryDurationSeconds * 1000)
        : readyAt;

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { preparationTimeMinutes: minutes, estimatedDeliveryTime },
      include: { items: { include: { customizations: true }, orderBy: { createdAt: 'asc' } } },
    });

    return toKitchenOrderResponse(updated);
  }

  /**
   * ADMIN status transition (plan §7.5). Validates against the
   * delivery-method-aware transition map (Fix 12A —
   * `getAllowedTransitions`), then claims the transition with an optimistic-concurrency
   * `updateMany` (guarded on the originally-read status) before writing the
   * OrderStatusHistory row — both in the same transaction. Two admins racing
   * from the same original status can both pass validation, but only one can
   * win the conditional claim; the other gets a 409 and never writes history
   * or fires any post-commit side effect. The Phase 6 notification
   * infrastructure still fires *after* that commit — a notification failure
   * is logged, never allowed to roll back or fail the already-committed
   * status change.
   */
  async updateOrderStatus(
    orderId: string,
    newStatus: OrderStatus,
    adminUserId: string,
    note?: string,
    options?: { expectedDriverId?: string },
  ): Promise<OrderResponseDto> {
    const existing = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!existing) {
      throw new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
    }

    // Driver-initiated transitions (see driverStartDelivery/driverMarkDelivered)
    // pass this so the ownership check and the status claim below are both
    // read from/verified against the SAME transaction-scoped update — a
    // reassignment racing this call makes the claim fail (count !== 1) rather
    // than silently letting a just-unassigned driver's request through.
    if (options?.expectedDriverId !== undefined && existing.driverId !== options.expectedDriverId) {
      throw new NotFoundException({
        message: 'Order not found or not assigned to you',
        code: 'ORDER_NOT_ASSIGNED',
      });
    }

    if (!getAllowedTransitions(existing.deliveryMethod, existing.status).includes(newStatus)) {
      throw new UnprocessableEntityException({
        message: `Cannot transition a ${existing.deliveryMethod} order from ${existing.status} to ${newStatus}`,
        code: 'INVALID_STATUS_TRANSITION',
      });
    }

    // ETA refresh on hand-off (Manual Kitchen Preparation Time / ETA feature):
    // kitchen prep is finished once the order leaves PREPARING, so the manual
    // prep-time-derived ETA is no longer the relevant number.
    // - OUT_FOR_DELIVERY (DELIVERY only): remaining ETA is now purely travel —
    //   refresh to this transition's time + the order's already-authoritative
    //   deliveryDurationSeconds. Left untouched if that snapshot is null.
    // - READY_FOR_PICKUP (PICKUP only): the order is ready right now.
    // Never applied to DELIVERED/PICKED_UP/CANCELLED — those are terminal and
    // must stop moving. Folded into the same optimistic-concurrency write as
    // the status claim below, not a separate update.
    const etaRefreshAt = new Date();
    const etaRefresh: Pick<Prisma.OrderUpdateManyMutationInput, 'estimatedDeliveryTime'> = {};
    if (newStatus === 'OUT_FOR_DELIVERY' && existing.deliveryDurationSeconds !== null) {
      etaRefresh.estimatedDeliveryTime = new Date(
        etaRefreshAt.getTime() + existing.deliveryDurationSeconds * 1000,
      );
    } else if (newStatus === 'READY_FOR_PICKUP') {
      etaRefresh.estimatedDeliveryTime = etaRefreshAt;
    }

    // Capture/void gating (Moyasar authorize+capture/void flow): must
    // succeed BEFORE the order transition below is allowed to commit — the
    // core business rule is that an order is never marked CONFIRMED before
    // its money is actually captured. A no-op for CASH/WALLET orders and for
    // a CARD order whose payment was never authorized (nothing to void, so
    // REJECT still proceeds); a CARD ACCEPT with no authorized payment
    // throws and blocks the transition entirely (see PaymentsService).
    if (existing.paymentMethod === 'CARD') {
      if (newStatus === 'CONFIRMED') {
        await this.paymentsService.captureAuthorizedPayment(orderId);
      } else if (newStatus === 'CANCELLED') {
        await this.paymentsService.voidAuthorizedPayment(orderId);
      }
    }

    let updated: Prisma.OrderGetPayload<{ include: typeof orderInclude }>;
    try {
      updated = await this.runStatusTransition(
        orderId,
        existing.status,
        newStatus,
        adminUserId,
        note,
        etaRefresh,
        options?.expectedDriverId !== undefined ? { driverId: options.expectedDriverId } : {},
      );
    } catch (error) {
      // The capture above already succeeded at Moyasar, but a second admin
      // action won the optimistic-concurrency race and changed the order
      // first — the just-captured payment is now orphaned from the order's
      // actual state. Self-heal with a compensating void rather than leaving
      // money held against an order nobody confirmed.
      if (existing.paymentMethod === 'CARD' && newStatus === 'CONFIRMED') {
        await this.paymentsService.compensateOrphanedCapture(orderId);
      }
      throw error;
    }

    if (isTerminalCompletion(newStatus)) {
      try {
        await this.paymentsService.settleCashOnDelivery(orderId);
      } catch (error) {
        this.logger.warn(
          `COD settlement failed for order ${orderId} (status change already committed): ${(error as Error).message}`,
        );
      }
      try {
        await this.loyaltyService.earnForOrder(updated);
      } catch (error) {
        this.logger.warn(
          `Loyalty earning failed for order ${orderId} (status change already committed): ${(error as Error).message}`,
        );
      }
    }

    try {
      await this.notificationsService.sendOrderStatusNotification({
        id: updated.id,
        userId: updated.userId,
        status: updated.status,
        deliveryMethod: updated.deliveryMethod,
      });
    } catch (error) {
      this.logger.warn(
        `Order-status notification failed for order ${orderId} (status change already committed): ${(error as Error).message}`,
      );
    }

    return toOrderResponse(updated);
  }

  /**
   * The optimistic-concurrency status claim + history write, unchanged from
   * before the capture/void gating was added — split out purely so
   * `updateOrderStatus` can wrap it in a try/catch for the compensating-void
   * self-heal above. `etaRefresh` (Manual Kitchen Preparation Time / ETA
   * feature) folds the OUT_FOR_DELIVERY/READY_FOR_PICKUP ETA write into this
   * same claim — empty for every other transition, so it changes nothing.
   */
  private async runStatusTransition(
    orderId: string,
    fromStatus: OrderStatus,
    newStatus: OrderStatus,
    adminUserId: string,
    note?: string,
    etaRefresh: Pick<Prisma.OrderUpdateManyMutationInput, 'estimatedDeliveryTime'> = {},
    extraClaimWhere: Prisma.OrderWhereInput = {},
  ): Promise<Prisma.OrderGetPayload<{ include: typeof orderInclude }>> {
    return this.prisma.$transaction(async (tx) => {
      // Optimistic concurrency claim: only succeeds if the order's status
      // (and, for a driver-initiated transition, its driver assignment via
      // extraClaimWhere) is still exactly what we read above. If a second
      // concurrent request already changed it, `count` comes back 0— no row
      // gets updated, so we never overwrite a status neither of us actually
      // observed live.
      const claimed = await tx.order.updateMany({
        where: {
          id: orderId,
          status: fromStatus,
          ...extraClaimWhere,
        },
        data: {
          status: newStatus,
          ...etaRefresh,
        },
      });

      if (claimed.count !== 1) {
        const current = await tx.order.findUnique({ where: { id: orderId } });
        throw new ConflictException({
          message: 'Order status changed before this update could be applied',
          code: 'ORDER_STATUS_CHANGED',
          details: {
            expectedStatus: fromStatus,
            currentStatus: current?.status ?? null,
          },
        });
      }

      await tx.orderStatusHistory.create({
        data: {
          orderId,
          fromStatus,
          toStatus: newStatus,
          changedByUserId: adminUserId,
          note: note ?? null,
        },
      });

      const result = await tx.order.findUnique({ where: { id: orderId }, include: orderInclude });
      if (!result) {
        throw new InternalServerErrorException({
          message: 'Order could not be reloaded after a committed status update',
          code: 'ORDER_RELOAD_FAILED',
        });
      }
      return result;
    });
  }

  /**
   * ADMIN: assign, reassign, or unassign (`driverId: null`) a driver on a
   * DELIVERY order. Assignment never itself changes `status` — it only ever
   * writes `driverId` + an audit row. Reassigning immediately revokes the
   * previous driver's access (their queries all filter on `driverId`, so a
   * changed value simply stops matching); no separate "revoke" step exists
   * or is needed.
   */
  async assignDriver(
    orderId: string,
    driverId: string | null,
    adminUserId: string,
  ): Promise<AdminOrderResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) {
        throw new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
      }
      if (order.deliveryMethod !== 'DELIVERY') {
        throw new UnprocessableEntityException({
          message: 'Only DELIVERY orders can be assigned to a driver',
          code: 'NOT_A_DELIVERY_ORDER',
        });
      }
      if (order.status === 'DELIVERED' || order.status === 'CANCELLED') {
        throw new UnprocessableEntityException({
          message: `Cannot change the driver assignment for a ${order.status} order`,
          code: 'ORDER_ALREADY_TERMINAL',
        });
      }

      if (driverId !== null) {
        const driver = await tx.user.findFirst({
          where: { id: driverId, role: UserRole.DRIVER, deletedAt: null },
          select: { id: true },
        });
        if (!driver) {
          throw new UnprocessableEntityException({
            message: 'Driver not found or not active',
            code: 'DRIVER_NOT_AVAILABLE',
          });
        }
      }

      if (order.driverId === driverId) {
        // No-op: already assigned to this exact driver (or already
        // unassigned). Idempotent success, no audit noise.
        const unchanged = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          include: orderInclude,
        });
        return toAdminOrderResponse(unchanged);
      }

      // Optimistic concurrency: only claims if driverId is still exactly what
      // we just read — a second concurrent admin assignment call on the same
      // order loses this race with a 409 instead of silently clobbering it.
      // `driverAssignmentVersion` (Phase 2 live tracking) is bumped on every
      // REAL change only — never on the no-op branch above — so
      // DriverLocationService can reject a delayed location update from an
      // obsolete assignment, including one from this same driver after being
      // unassigned and reassigned back (a plain driverId check alone
      // couldn't distinguish that from "still the original assignment").
      const claimed = await tx.order.updateMany({
        where: { id: orderId, driverId: order.driverId },
        data: { driverId, driverAssignmentVersion: { increment: 1 } },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          message: 'Order driver assignment changed before this update could be applied',
          code: 'ASSIGNMENT_CHANGED',
        });
      }

      await tx.orderDriverAssignmentHistory.create({
        data: {
          orderId,
          fromDriverId: order.driverId,
          toDriverId: driverId,
          changedByUserId: adminUserId,
        },
      });

      const reloaded = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: orderInclude,
      });
      return toAdminOrderResponse(reloaded);
    });
  }

  /** DRIVER: paginated orders currently assigned to the caller that have not
   * yet reached a terminal status. */
  async driverListActiveOrders(
    driverId: string,
    query: ListDriverOrdersDto,
  ): Promise<DriverOrderResponseDto[]> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const orders = await this.prisma.order.findMany({
      where: { driverId, status: { in: DRIVER_ACTIVE_STATUSES } },
      include: driverOrderInclude,
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return orders.map((order) => toDriverOrderResponse(order));
  }

  /** DRIVER: paginated completed-delivery history. Only orders still
   * currently assigned to this driver (a reassigned-away order disappears
   * from history too — see DRIVER_HISTORY_STATUSES doc comment). Customer
   * phone is stripped — see toDriverOrderHistoryResponse. */
  async driverListHistory(
    driverId: string,
    query: ListDriverOrdersDto,
  ): Promise<DriverOrderResponseDto[]> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const orders = await this.prisma.order.findMany({
      where: { driverId, status: { in: DRIVER_HISTORY_STATUSES } },
      include: driverOrderInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return orders.map((order) => toDriverOrderHistoryResponse(order));
  }

  /** DRIVER: a single assigned order's detail. Unscoped by status (like
   * kitchenGetOrder) — a driver already viewing an order shouldn't 404 just
   * because it reached a terminal status mid-view. Ownership (`driverId`) is
   * still strictly enforced: any other order 404s, never leaking existence. */
  async driverGetOrder(driverId: string, orderId: string): Promise<DriverOrderResponseDto> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, driverId },
      include: driverOrderInclude,
    });
    if (!order) {
      throw new NotFoundException({
        message: 'Order not found or not assigned to you',
        code: 'ORDER_NOT_ASSIGNED',
      });
    }
    return toDriverOrderResponse(order);
  }

  /** DRIVER: "Picked up / Start delivery" — PREPARING -> OUT_FOR_DELIVERY. */
  async driverStartDelivery(driverId: string, orderId: string): Promise<DriverOrderResponseDto> {
    return this.driverAdvanceStatus(driverId, orderId, 'OUT_FOR_DELIVERY');
  }

  /** DRIVER: "Delivered" — OUT_FOR_DELIVERY -> DELIVERED. Reuses
   * updateOrderStatus so COD settlement / loyalty earning / the customer
   * notification all fire exactly as they do for an admin-driven transition
   * — never duplicated, never reimplemented. */
  async driverMarkDelivered(driverId: string, orderId: string): Promise<DriverOrderResponseDto> {
    return this.driverAdvanceStatus(driverId, orderId, 'DELIVERED');
  }

  /**
   * Shared driver-transition path. Ownership is checked up front (404s a
   * non-assigned/unknown order without revealing whether it exists), then:
   *  - already at the target status -> idempotent replay, no history row, no
   *    side effects re-fired (handles a duplicate/retried request safely).
   *  - otherwise -> delegates to updateOrderStatus with expectedDriverId, whose
   *    transition-map validation naturally rejects any skipped/invalid move
   *    (e.g. PENDING -> DELIVERED) with the same INVALID_STATUS_TRANSITION the
   *    admin path uses, and whose atomic claim (via extraClaimWhere) rejects a
   *    reassignment that raced this exact call.
   */
  private async driverAdvanceStatus(
    driverId: string,
    orderId: string,
    targetStatus: OrderStatus,
  ): Promise<DriverOrderResponseDto> {
    const existing = await this.prisma.order.findFirst({
      where: { id: orderId, driverId },
      include: driverOrderInclude,
    });
    if (!existing) {
      throw new NotFoundException({
        message: 'Order not found or not assigned to you',
        code: 'ORDER_NOT_ASSIGNED',
      });
    }
    if (existing.status === targetStatus) {
      return toDriverOrderResponse(existing as DriverOrderWithRelations);
    }

    await this.updateOrderStatus(orderId, targetStatus, driverId, undefined, {
      expectedDriverId: driverId,
    });

    const reloaded = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: driverOrderInclude,
    });
    return toDriverOrderResponse(reloaded);
  }

  private generateOrderNumber(): string {
    const now = new Date();
    const yy = String(now.getUTCFullYear()).slice(2);
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const suffix = randomBytes(4).toString('hex');
    return `KZ-${yy}${mm}${dd}-${suffix}`;
  }

  private isOrderNumberConflict(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      return false;
    }
    const target = error.meta?.target;
    return Array.isArray(target)
      ? target.includes('orderNumber')
      : String(target).includes('orderNumber');
  }

  /** Postgres serialization failure under Serializable isolation — safe to retry from scratch. */
  private isSerializationFailure(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
  }
}
