import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CartService } from '../cart/cart.service';
import { PricingService } from '../pricing/pricing.service';
import { SettingsService } from '../settings/settings.service';
import { DeliveryZonesService } from '../delivery-zones/delivery-zones.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { AdminNotificationsService } from '../admin-notifications/admin-notifications.service';
import { CheckoutDto } from './dto/checkout.dto';

const D = (v: string | number) => new Prisma.Decimal(v);

/** Re-runs evaluatePromo (guard against a race between two concurrent checkouts). */
describe('OrdersService.checkout — in-transaction promo re-validation', () => {
  const userId = 'user-1';
  const promo = {
    id: 'promo-1',
    code: 'SAVE10',
    maxUsage: null as number | null,
    perUserLimit: 1,
  };

  const breakdown = {
    lines: [
      {
        menuItem: { id: 'item-1', nameAr: 'صنف', nameEn: 'Item', imageUrl: null },
        variant: null,
        addons: [],
        quantity: 1,
        unitPrice: D(50),
        lineTotal: D(50),
      },
    ],
    subtotal: D(50),
    discount: D(5),
    tax: D('6.30'),
    deliveryFee: D(0),
    totalAmount: D('51.30'),
    currency: 'EGP',
    promo,
  };

  const createdOrderFixture = {
    id: 'order-1',
    orderNumber: 'KZ-260805-abcd1234',
    userId,
    user: {
      id: userId,
      fullName: 'Test User',
      email: 'test@example.com',
      phone: null,
      avatarUrl: null,
      role: 'CUSTOMER',
      isGuest: false,
      locale: 'en',
      createdAt: new Date(),
    },
    items: [],
    status: 'PENDING',
    deliveryAddressJson: { type: 'PICKUP' },
    deliveryMethod: 'PICKUP',
    paymentMethod: 'CASH',
    paymentStatus: 'PENDING',
    subtotal: D(50),
    deliveryFee: D(0),
    tax: D('6.30'),
    discount: D(5),
    totalAmount: D('51.30'),
    createdAt: new Date(),
    estimatedDeliveryTime: null,
    deliveryZoneId: null,
    deliveryZoneNameArSnapshot: null,
    deliveryZoneNameEnSnapshot: null,
  };

  const dto: CheckoutDto = {
    deliveryMethod: 'PICKUP',
    paymentMethod: 'CASH',
    promoCode: 'SAVE10',
  } as CheckoutDto;

  let prisma: {
    payment: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    promoCode: { updateMany: jest.Mock };
    order: { create: jest.Mock };
    cartItem: { deleteMany: jest.Mock };
  };
  let pricingService: { priceCart: jest.Mock; evaluatePromo: jest.Mock; applyDiscount: jest.Mock };
  let cartService: { getCartForCheckout: jest.Mock };
  let settingsService: { getSettings: jest.Mock };
  let notificationsService: { sendAdminNewOrderNotification: jest.Mock };
  let adminNotificationsService: { createForNewOrder: jest.Mock };
  let service: OrdersService;

  beforeEach(() => {
    tx = {
      promoCode: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      order: { create: jest.fn().mockResolvedValue(createdOrderFixture) },
      cartItem: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma = {
      payment: { findUnique: jest.fn() },
      $transaction: jest.fn((callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    };
    pricingService = {
      priceCart: jest.fn().mockResolvedValue(breakdown),
      evaluatePromo: jest.fn().mockResolvedValue({ promo, discount: breakdown.discount }),
      applyDiscount: jest.fn(),
    };
    cartService = {
      getCartForCheckout: jest.fn().mockResolvedValue({
        cartId: 'cart-1',
        items: [{ specialInstructions: null }],
        inputs: [{ menuItemId: 'item-1', variantId: null, addonIds: [], quantity: 1 }],
      }),
    };
    settingsService = {
      getSettings: jest.fn().mockResolvedValue({
        acceptingOrders: true,
        closedMessageAr: null,
        closedMessageEn: null,
        minOrderAmount: D(0),
        taxRatePercent: D(14),
        deliveryFee: D(0),
        currency: 'EGP',
      }),
    };
    notificationsService = {
      sendAdminNewOrderNotification: jest.fn().mockResolvedValue(undefined),
    };
    adminNotificationsService = {
      createForNewOrder: jest.fn().mockResolvedValue({ id: 'notif-1' }),
    };

    service = new OrdersService(
      prisma as unknown as PrismaService,
      cartService as unknown as CartService,
      pricingService as unknown as PricingService,
      settingsService as unknown as SettingsService,
      {} as DeliveryZonesService,
      notificationsService as unknown as NotificationsService,
      {} as PaymentsService,
      {} as LoyaltyService,
      adminNotificationsService as unknown as AdminNotificationsService,
    );
  });

  it('re-validates the promo inside the transaction (fresh, tx-scoped read) even though the cart already carries it', async () => {
    await service.checkout(userId, dto);

    expect(pricingService.evaluatePromo).toHaveBeenCalledWith(
      promo.code,
      breakdown.subtotal,
      userId,
      tx,
    );
    // The in-transaction re-check must run before the order (and the usageCount
    // increment) are committed.
    const evaluateOrder = pricingService.evaluatePromo.mock.invocationCallOrder[0];
    const createOrder = tx.order.create.mock.invocationCallOrder[0];
    expect(evaluateOrder).toBeLessThan(createOrder);
    expect(tx.promoCode.updateMany).toHaveBeenCalledTimes(1);
  });

  it('does not increment usageCount or create the order when the in-transaction re-check rejects it', async () => {
    pricingService.evaluatePromo.mockRejectedValueOnce(
      new ConflictException({
        message: 'You have already used this promo code',
        code: 'PROMO_ALREADY_USED',
      }),
    );

    await expect(service.checkout(userId, dto)).rejects.toMatchObject({
      response: { code: 'PROMO_ALREADY_USED' },
    });

    expect(tx.promoCode.updateMany).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
  });
});
