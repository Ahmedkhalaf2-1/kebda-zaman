import { randomBytes, randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CartService } from '../cart/cart.service';
import { PricingService } from '../pricing/pricing.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import {
  OrderResponseDto,
  OrderStatusResponseDto,
  toFrontendStatus,
  toOrderResponse,
  toStatusHistoryEntry,
  FRONTEND_STATUS_TO_ORDER_STATUS,
} from '../../common/mappers/order-response.mapper';
import { CheckoutDto } from './dto/checkout.dto';
import { ListOrdersDto } from './dto/list-orders.dto';
import { AdminListOrdersDto } from './dto/admin-list-orders.dto';

const orderInclude = {
  user: true,
  items: { include: { customizations: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.OrderInclude;

const MAX_ORDER_NUMBER_ATTEMPTS = 5;

/** Forward transitions + cancellation rules (plan §7.5). No READY: see D2a. */
const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cartService: CartService,
    private readonly pricingService: PricingService,
    private readonly settingsService: SettingsService,
    private readonly notificationsService: NotificationsService,
    private readonly paymentsService: PaymentsService,
    private readonly loyaltyService: LoyaltyService,
  ) {}

  /**
   * Transactional checkout (plan §6.3/§7.2). Re-runs the full authoritative
   * pricing pass — the client never influences a single money figure. On any
   * failure the transaction rolls back and the cart is left untouched;
   * on success the cart is cleared only inside that same transaction.
   */
  async checkout(
    userId: string,
    dto: CheckoutDto,
    idempotencyKeyHeader?: string,
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
        return toOrderResponse(existingPayment.order);
      }
    }

    if (dto.deliveryMethod === 'DELIVERY' && !dto.deliveryAddress) {
      throw new UnprocessableEntityException({
        message: 'A delivery address is required for delivery orders',
        code: 'DELIVERY_ADDRESS_REQUIRED',
      });
    }

    const { cartId, items, inputs } = await this.cartService.getCartForCheckout(userId);
    if (items.length === 0) {
      throw new ConflictException({ message: 'Cart is empty', code: 'EMPTY_CART' });
    }

    const settings = await this.settingsService.getSettings();
    // Authoritative repricing: re-validates every item/variant/addon and the
    // promo from fresh DB reads. Never trusts anything the client sent
    // beyond references+quantities+deliveryMethod+promoCode.
    const breakdown = await this.pricingService.priceCart(
      inputs,
      settings,
      dto.deliveryMethod,
      dto.promoCode ?? null,
    );

    if (breakdown.subtotal.lessThan(settings.minOrderAmount)) {
      throw new UnprocessableEntityException({
        message: `Minimum order amount of ${settings.minOrderAmount.toString()} not met`,
        code: 'BELOW_MIN_ORDER',
      });
    }

    const addressSnapshot: Prisma.InputJsonValue =
      dto.deliveryMethod === 'DELIVERY' && dto.deliveryAddress
        ? { ...dto.deliveryAddress }
        : { type: 'PICKUP' };

    for (let attempt = 1; attempt <= MAX_ORDER_NUMBER_ATTEMPTS; attempt += 1) {
      const orderNumber = this.generateOrderNumber();
      try {
        const order = await this.prisma.$transaction(async (tx) => {
          if (breakdown.promo) {
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
                create: [{ toStatus: 'PENDING', changedByUserId: userId, note: dto.notes ?? null }],
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

          // Cart is cleared only after the order is fully created, inside
          // this same transaction — any earlier failure leaves it untouched.
          await tx.cartItem.deleteMany({ where: { cartId } });

          return created;
        });

        return toOrderResponse(order);
      } catch (error) {
        if (this.isOrderNumberConflict(error) && attempt < MAX_ORDER_NUMBER_ATTEMPTS) {
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
    return orders.map(toOrderResponse);
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
  async adminListOrders(query: AdminListOrdersDto): Promise<OrderResponseDto[]> {
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
    return orders.map(toOrderResponse);
  }

  /** ADMIN: no ownership restriction — any order. */
  async adminGetOrder(orderId: string): Promise<OrderResponseDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: orderInclude,
    });
    if (!order) {
      throw new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
    }
    return toOrderResponse(order);
  }

  /**
   * ADMIN status transition (plan §7.5). Validates against the allowed
   * transition map, writes the order update + OrderStatusHistory row in one
   * transaction, then fires the Phase 6 notification infrastructure
   * *after* that commit — a notification failure is logged, never allowed
   * to roll back or fail the already-committed status change.
   */
  async updateOrderStatus(
    orderId: string,
    newStatus: OrderStatus,
    adminUserId: string,
    note?: string,
  ): Promise<OrderResponseDto> {
    const existing = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!existing) {
      throw new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
    }

    if (!ALLOWED_TRANSITIONS[existing.status].includes(newStatus)) {
      throw new UnprocessableEntityException({
        message: `Cannot transition order from ${existing.status} to ${newStatus}`,
        code: 'INVALID_STATUS_TRANSITION',
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.order.update({
        where: { id: orderId },
        data: { status: newStatus },
        include: orderInclude,
      });
      await tx.orderStatusHistory.create({
        data: {
          orderId,
          fromStatus: existing.status,
          toStatus: newStatus,
          changedByUserId: adminUserId,
          note: note ?? null,
        },
      });
      return result;
    });

    if (newStatus === 'DELIVERED') {
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
      });
    } catch (error) {
      this.logger.warn(
        `Order-status notification failed for order ${orderId} (status change already committed): ${(error as Error).message}`,
      );
    }

    return toOrderResponse(updated);
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
}
