import { buildOrderStatusPayload } from './notification-payload';

describe('buildOrderStatusPayload', () => {
  it('DELIVERY + OUT_FOR_DELIVERY: keeps delivery-specific wording', () => {
    const payload = buildOrderStatusPayload('order-1', 'OUT_FOR_DELIVERY', 'DELIVERY');

    expect(payload).toMatchObject({
      type: 'order_out_for_delivery',
      title: 'Order out for delivery',
      body: 'Your order is on its way.',
    });
  });

  it('PICKUP + READY_FOR_PICKUP: presents as ready for pickup', () => {
    const payload = buildOrderStatusPayload('order-1', 'READY_FOR_PICKUP', 'PICKUP');

    expect(payload).toMatchObject({
      type: 'order_ready',
      title: 'Order ready for pickup',
      body: 'Your order is ready to be collected.',
    });
  });

  it('DELIVERY + READY_FOR_PICKUP: unreachable combination returns null', () => {
    expect(buildOrderStatusPayload('order-1', 'READY_FOR_PICKUP', 'DELIVERY')).toBeNull();
  });

  it('PICKUP + OUT_FOR_DELIVERY: unreachable combination returns null', () => {
    expect(buildOrderStatusPayload('order-1', 'OUT_FOR_DELIVERY', 'PICKUP')).toBeNull();
  });

  it('DELIVERY + DELIVERED: keeps delivery-specific wording', () => {
    const payload = buildOrderStatusPayload('order-1', 'DELIVERED', 'DELIVERY');

    expect(payload).toMatchObject({
      type: 'order_delivered',
      title: 'Order delivered',
      body: 'Your order has been delivered. Enjoy!',
    });
  });

  it('PICKUP + PICKED_UP: reuses order_delivered type but with picked-up wording', () => {
    const payload = buildOrderStatusPayload('order-1', 'PICKED_UP', 'PICKUP');

    expect(payload).toMatchObject({
      type: 'order_delivered',
      title: 'Order picked up',
      body: 'Your order has been picked up. Enjoy!',
    });
  });

  it('DELIVERY + PICKED_UP: unreachable combination returns null', () => {
    expect(buildOrderStatusPayload('order-1', 'PICKED_UP', 'DELIVERY')).toBeNull();
  });

  it('PICKUP + DELIVERED: unreachable combination returns null', () => {
    expect(buildOrderStatusPayload('order-1', 'DELIVERED', 'PICKUP')).toBeNull();
  });

  describe('statuses shared between DELIVERY and PICKUP', () => {
    const sharedCases: Array<{
      status: 'PENDING' | 'CONFIRMED' | 'PREPARING' | 'CANCELLED';
      type: string;
      title: string;
      body: string;
    }> = [
      { status: 'PENDING', type: 'order_created', title: 'Order placed', body: 'Your order has been received.' },
      {
        status: 'CONFIRMED',
        type: 'order_confirmed',
        title: 'Order confirmed',
        body: 'Your order has been confirmed.',
      },
      {
        status: 'PREPARING',
        type: 'order_preparing',
        title: 'Order in progress',
        body: 'Your order is being prepared.',
      },
      {
        status: 'CANCELLED',
        type: 'order_cancelled',
        title: 'Order cancelled',
        body: 'Your order has been cancelled.',
      },
    ];

    it.each(sharedCases)('$status is identical for PICKUP and DELIVERY', ({ status, type, title, body }) => {
      const deliveryPayload = buildOrderStatusPayload('order-1', status, 'DELIVERY');
      const pickupPayload = buildOrderStatusPayload('order-1', status, 'PICKUP');

      expect(deliveryPayload).toMatchObject({ type, title, body });
      expect(pickupPayload).toMatchObject({ type, title, body });
    });
  });

  it('an unmapped status (not a real DB OrderStatus value) still returns null for either delivery method', () => {
    // 'READY' (bare, no suffix) is not a real OrderStatus value — cast to
    // exercise the fallback path without a genuine enum member.
    const unmapped = 'READY' as unknown as Parameters<typeof buildOrderStatusPayload>[1];

    expect(buildOrderStatusPayload('order-1', unmapped, 'DELIVERY')).toBeNull();
    expect(buildOrderStatusPayload('order-1', unmapped, 'PICKUP')).toBeNull();
  });

  it('preserves the payload contract (route/entityId/entityType/orderId) regardless of delivery method', () => {
    const payload = buildOrderStatusPayload('order-42', 'READY_FOR_PICKUP', 'PICKUP');

    expect(payload).toMatchObject({
      route: '/orders/tracking/order-42',
      entityId: 'order-42',
      entityType: 'order',
      orderId: 'order-42',
    });
    expect(payload?.id).toEqual(expect.any(String));
    expect(payload?.timestamp).toEqual(expect.any(String));
  });
});
