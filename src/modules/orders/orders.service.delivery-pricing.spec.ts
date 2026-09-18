import { Prisma } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CartService } from '../cart/cart.service';
import { PricingService } from '../pricing/pricing.service';
import { SettingsService } from '../settings/settings.service';
import {
  DeliveryPricingService,
  DeliveryQuoteResult,
} from '../delivery-pricing/delivery-pricing.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { AdminNotificationsService } from '../admin-notifications/admin-notifications.service';
import { CheckoutDto } from './dto/checkout.dto';

const D = (v: string | number) => new Prisma.Decimal(v);

const deliverableTier = {
  id: 'tier-1',
  minDistanceKm: D('0.00'),
  maxDistanceKm: D('15.00'),
  deliveryFee: D('10.00'),
  minimumOrder: D('0.00'),
};

const deliverableQuote: DeliveryQuoteResult = {
  deliverable: true,
  distanceMeters: 5_000,
  durationSeconds: 600,
  currency: 'SAR',
  tier: deliverableTier as never,
};

const outOfRangeQuote: DeliveryQuoteResult = {
  deliverable: false,
  distanceMeters: 30_500,
  durationSeconds: 2400,
  currency: 'SAR',
  tier: null,
  reason: 'OUTSIDE_DELIVERY_RANGE',
};

describe('OrdersService.checkout — distance-based delivery pricing', () => {
  const userId = 'user-1';

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
    discount: D(0),
    tax: D('7.00'),
    deliveryFee: D('10.00'),
    totalAmount: D('67.00'),
    currency: 'SAR',
    promo: null,
  };

  const createdOrderFixture = {
    id: 'order-1',
    orderNumber: 'KZ-260806-abcd1234',
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
    deliveryAddressJson: { title: 'Home', latitude: 21.6, longitude: 39.2 },
    deliveryMethod: 'DELIVERY',
    paymentMethod: 'CASH',
    paymentStatus: 'PENDING',
    subtotal: D(50),
    deliveryFee: D('10.00'),
    tax: D('7.00'),
    discount: D(0),
    totalAmount: D('67.00'),
    createdAt: new Date(),
    estimatedDeliveryTime: null,
    deliveryZoneId: null,
    deliveryZoneNameArSnapshot: null,
    deliveryZoneNameEnSnapshot: null,
    deliveryDistanceMeters: 5_000,
    deliveryDurationSeconds: 600,
    deliveryTierId: 'tier-1',
    deliveryTierMinKmSnapshot: D('0.00'),
    deliveryTierMaxKmSnapshot: D('15.00'),
  };

  const deliveryDto: CheckoutDto = {
    deliveryMethod: 'DELIVERY',
    paymentMethod: 'CASH',
    deliveryAddress: {
      title: 'Home',
      street: 'Main St',
      building: '1',
      city: 'Jeddah',
      latitude: 21.6,
      longitude: 39.2,
    },
  } as CheckoutDto;

  let prisma: { payment: { findUnique: jest.Mock }; $transaction: jest.Mock };
  let tx: {
    promoCode: { updateMany: jest.Mock };
    order: { create: jest.Mock };
    cartItem: { deleteMany: jest.Mock };
  };
  let pricingService: { priceCart: jest.Mock; evaluatePromo: jest.Mock; applyDiscount: jest.Mock };
  let cartService: { getCartForCheckout: jest.Mock };
  let settingsService: { getSettings: jest.Mock };
  let deliveryPricingService: { getAuthoritativeQuote: jest.Mock };
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
      evaluatePromo: jest.fn(),
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
        deliveryFee: D('20.00'),
        currency: 'SAR',
      }),
    };
    deliveryPricingService = {
      getAuthoritativeQuote: jest.fn().mockResolvedValue(deliverableQuote),
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
      deliveryPricingService as unknown as DeliveryPricingService,
      notificationsService as unknown as NotificationsService,
      {} as PaymentsService,
      {} as LoyaltyService,
      adminNotificationsService as unknown as AdminNotificationsService,
    );
  });

  it('recalculates distance server-side and ignores any client-supplied fee/distance/tier', async () => {
    await service.checkout(userId, deliveryDto);

    expect(deliveryPricingService.getAuthoritativeQuote).toHaveBeenCalledWith({
      latitude: 21.6,
      longitude: 39.2,
    });
    // The fee passed into priceCart comes only from the server-resolved tier.
    expect(pricingService.priceCart).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'DELIVERY',
      null,
      deliverableTier.deliveryFee,
      userId,
    );
  });

  it('persists the distance/tier snapshot fields on the created order', async () => {
    await service.checkout(userId, deliveryDto);

    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deliveryDistanceMeters: 5_000,
          deliveryDurationSeconds: 600,
          deliveryTierId: 'tier-1',
          deliveryTierMinKmSnapshot: deliverableTier.minDistanceKm,
          deliveryTierMaxKmSnapshot: deliverableTier.maxDistanceKm,
        }),
      }),
    );
  });

  it('rejects a destination beyond the deliverable range (OUTSIDE_DELIVERY_RANGE) before any pricing/DB write', async () => {
    deliveryPricingService.getAuthoritativeQuote.mockResolvedValue(outOfRangeQuote);

    await expect(service.checkout(userId, deliveryDto)).rejects.toMatchObject({
      response: { code: 'OUTSIDE_DELIVERY_RANGE', details: { distanceMeters: 30_500 } },
    });
    expect(pricingService.priceCart).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('rejects a DELIVERY checkout with no coordinates (DELIVERY_COORDINATES_REQUIRED)', async () => {
    const dtoWithoutCoords: CheckoutDto = {
      ...deliveryDto,
      deliveryAddress: {
        ...deliveryDto.deliveryAddress!,
        latitude: undefined,
        longitude: undefined,
      },
    } as CheckoutDto;

    await expect(service.checkout(userId, dtoWithoutCoords)).rejects.toMatchObject({
      response: { code: 'DELIVERY_COORDINATES_REQUIRED' },
    });
    expect(deliveryPricingService.getAuthoritativeQuote).not.toHaveBeenCalled();
  });

  it('never calls Google Routes for a PICKUP order and keeps the delivery fee at zero', async () => {
    const pickupDto: CheckoutDto = {
      deliveryMethod: 'PICKUP',
      paymentMethod: 'CASH',
    } as CheckoutDto;
    pricingService.priceCart.mockResolvedValue({
      ...breakdown,
      deliveryFee: D(0),
      totalAmount: D('57.00'),
    });

    await service.checkout(userId, pickupDto);

    expect(deliveryPricingService.getAuthoritativeQuote).not.toHaveBeenCalled();
    expect(pricingService.priceCart).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'PICKUP',
      null,
      undefined,
      userId,
    );
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deliveryDistanceMeters: null,
          deliveryDurationSeconds: null,
          deliveryTierId: null,
          deliveryTierMinKmSnapshot: null,
          deliveryTierMaxKmSnapshot: null,
        }),
      }),
    );
  });
});
