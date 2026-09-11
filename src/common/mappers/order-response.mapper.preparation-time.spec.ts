import { Prisma } from '@prisma/client';
import {
  OrderWithRelations,
  toAdminOrderResponse,
  toKitchenOrderResponse,
  toOrderResponse,
} from './order-response.mapper';

/**
 * Manual Kitchen Preparation Time / ETA feature — response-shape contract:
 *  - kitchen ticket exposes both preparationTimeMinutes and estimatedDeliveryTime.
 *  - customer response keeps exposing the final estimatedDeliveryTime (unchanged
 *    contract) and never leaks preparationTimeMinutes.
 *  - admin response additively exposes preparationTimeMinutes (admins may
 *    inspect/override it) without dropping any existing field.
 */
describe('order-response.mapper — preparationTimeMinutes / estimatedDeliveryTime', () => {
  const eta = new Date('2026-01-01T12:30:00.000Z');

  function orderWithRelationsFixture(
    overrides: Partial<Record<string, unknown>> = {},
  ): OrderWithRelations {
    return {
      id: 'order-1',
      orderNumber: 'KZ-260101-test',
      userId: 'user-1',
      user: {
        id: 'user-1',
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
      status: 'CONFIRMED',
      deliveryAddressJson: { type: 'PICKUP' },
      deliveryMethod: 'PICKUP',
      paymentMethod: 'CASH',
      paymentStatus: 'PENDING',
      subtotal: new Prisma.Decimal(50),
      deliveryFee: new Prisma.Decimal(0),
      tax: new Prisma.Decimal(0),
      discount: new Prisma.Decimal(0),
      totalAmount: new Prisma.Decimal(50),
      createdAt: new Date('2026-01-01T11:00:00.000Z'),
      estimatedDeliveryTime: eta,
      deliveryZoneId: null,
      deliveryZoneNameArSnapshot: null,
      deliveryZoneNameEnSnapshot: null,
      deliveryDistanceMeters: null,
      deliveryDurationSeconds: null,
      deliveryTierId: null,
      deliveryTierMinKmSnapshot: null,
      deliveryTierMaxKmSnapshot: null,
      preparationTimeMinutes: 20,
      payments: [],
      ...overrides,
    } as unknown as OrderWithRelations;
  }

  it('kitchen response includes preparationTimeMinutes and estimatedDeliveryTime', () => {
    const order = orderWithRelationsFixture();
    const result = toKitchenOrderResponse(order as never);

    expect(result.preparationTimeMinutes).toBe(20);
    expect(result.estimatedDeliveryTime).toBe(eta.toISOString());
  });

  it('kitchen response reflects a null preparationTimeMinutes (never set yet)', () => {
    const order = orderWithRelationsFixture({
      preparationTimeMinutes: null,
      estimatedDeliveryTime: null,
    });
    const result = toKitchenOrderResponse(order as never);

    expect(result.preparationTimeMinutes).toBeNull();
    expect(result.estimatedDeliveryTime).toBeNull();
  });

  it('customer response still exposes the final estimatedDeliveryTime', () => {
    const order = orderWithRelationsFixture();
    const result = toOrderResponse(order);

    expect(result.estimatedDeliveryTime).toBe(eta.toISOString());
  });

  it('customer response does not leak preparationTimeMinutes', () => {
    const order = orderWithRelationsFixture();
    const result = toOrderResponse(order);

    expect(result).not.toHaveProperty('preparationTimeMinutes');
  });

  it('admin response additively exposes preparationTimeMinutes alongside every existing field', () => {
    const order = orderWithRelationsFixture();
    const result = toAdminOrderResponse(order);

    expect(result.preparationTimeMinutes).toBe(20);
    expect(result.estimatedDeliveryTime).toBe(eta.toISOString());
    expect(result.orderNumber).toBe('KZ-260101-test');
  });
});
