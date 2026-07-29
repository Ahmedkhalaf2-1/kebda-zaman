import { Logger } from '@nestjs/common';
import type { App } from 'firebase-admin/app';
import type { SendResponse } from 'firebase-admin/messaging';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AppNotificationPayload } from './notification-payload';

jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(),
}));

const { getMessaging } = require('firebase-admin/messaging') as { getMessaging: jest.Mock };

function makeTokens(count: number, prefix = 'token'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
}

/** All-success SendResponse[] of a given length, unless overridden by index. */
function successResponses(
  count: number,
  invalidIndexes: Record<number, string> = {},
): SendResponse[] {
  return Array.from({ length: count }, (_, i) =>
    i in invalidIndexes
      ? ({ success: false, error: { code: invalidIndexes[i] } } as unknown as SendResponse)
      : ({ success: true } as SendResponse),
  );
}

const CUSTOMER_PAYLOAD: AppNotificationPayload = {
  id: 'campaign-1',
  type: 'promotion',
  title: 'Big sale',
  body: 'Everything is on sale today.',
  timestamp: '1234567890',
};

describe('NotificationsService — FCM multicast batching', () => {
  let prisma: { deviceToken: { updateMany: jest.Mock; findMany: jest.Mock } };

  beforeEach(() => {
    getMessaging.mockReset();
    prisma = {
      deviceToken: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn(),
      },
    };
  });

  function makeService(firebaseApp: App | null = {} as App): NotificationsService {
    return new NotificationsService(firebaseApp, prisma as unknown as PrismaService);
  }

  it('zero tokens: makes no Firebase call and returns 0 success / 0 failure', async () => {
    const service = makeService();

    const result = await service.sendToTokens([], CUSTOMER_PAYLOAD);

    expect(getMessaging).not.toHaveBeenCalled();
    expect(result).toEqual({ successCount: 0, failureCount: 0, invalidTokens: [] });
  });

  it('one token: sends exactly one Firebase call', async () => {
    const tokens = makeTokens(1);
    const sendEachForMulticast = jest
      .fn()
      .mockResolvedValue({ successCount: 1, failureCount: 0, responses: successResponses(1) });
    getMessaging.mockReturnValue({ sendEachForMulticast });
    const service = makeService();

    const result = await service.sendToTokens(tokens, CUSTOMER_PAYLOAD);

    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast.mock.calls[0][0].tokens).toEqual(tokens);
    expect(result).toEqual({ successCount: 1, failureCount: 0, invalidTokens: [] });
  });

  it('exactly 500 tokens: sends one Firebase call with a batch of 500', async () => {
    const tokens = makeTokens(500);
    const sendEachForMulticast = jest
      .fn()
      .mockResolvedValue({ successCount: 500, failureCount: 0, responses: successResponses(500) });
    getMessaging.mockReturnValue({ sendEachForMulticast });
    const service = makeService();

    const result = await service.sendToTokens(tokens, CUSTOMER_PAYLOAD);

    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast.mock.calls[0][0].tokens).toHaveLength(500);
    expect(sendEachForMulticast.mock.calls[0][0].tokens).toEqual(tokens);
    expect(result).toEqual({ successCount: 500, failureCount: 0, invalidTokens: [] });
  });

  it('501 tokens: sends two batches (500 + 1) with correct aggregate counts', async () => {
    const tokens = makeTokens(501);
    const sendEachForMulticast = jest
      .fn()
      .mockResolvedValueOnce({ successCount: 500, failureCount: 0, responses: successResponses(500) })
      .mockResolvedValueOnce({ successCount: 1, failureCount: 0, responses: successResponses(1) });
    getMessaging.mockReturnValue({ sendEachForMulticast });
    const service = makeService();

    const result = await service.sendToTokens(tokens, CUSTOMER_PAYLOAD);

    expect(sendEachForMulticast).toHaveBeenCalledTimes(2);
    expect(sendEachForMulticast.mock.calls[0][0].tokens).toHaveLength(500);
    expect(sendEachForMulticast.mock.calls[0][0].tokens).toEqual(tokens.slice(0, 500));
    expect(sendEachForMulticast.mock.calls[1][0].tokens).toHaveLength(1);
    expect(sendEachForMulticast.mock.calls[1][0].tokens).toEqual(tokens.slice(500));
    expect(result).toEqual({ successCount: 501, failureCount: 0, invalidTokens: [] });
  });

  it('1201 tokens: sends three batches (500 + 500 + 201) with correct aggregate counts', async () => {
    const tokens = makeTokens(1201);
    const sendEachForMulticast = jest
      .fn()
      .mockResolvedValueOnce({ successCount: 490, failureCount: 10, responses: successResponses(500) })
      .mockResolvedValueOnce({ successCount: 500, failureCount: 0, responses: successResponses(500) })
      .mockResolvedValueOnce({ successCount: 200, failureCount: 1, responses: successResponses(201) });
    getMessaging.mockReturnValue({ sendEachForMulticast });
    const service = makeService();

    const result = await service.sendToTokens(tokens, CUSTOMER_PAYLOAD);

    expect(sendEachForMulticast).toHaveBeenCalledTimes(3);
    expect(sendEachForMulticast.mock.calls[0][0].tokens).toHaveLength(500);
    expect(sendEachForMulticast.mock.calls[0][0].tokens).toEqual(tokens.slice(0, 500));
    expect(sendEachForMulticast.mock.calls[1][0].tokens).toHaveLength(500);
    expect(sendEachForMulticast.mock.calls[1][0].tokens).toEqual(tokens.slice(500, 1000));
    expect(sendEachForMulticast.mock.calls[2][0].tokens).toHaveLength(201);
    expect(sendEachForMulticast.mock.calls[2][0].tokens).toEqual(tokens.slice(1000));
    expect(result.successCount).toBe(490 + 500 + 200);
    expect(result.failureCount).toBe(10 + 0 + 1);
  });

  it('maps invalid tokens from different batches to the correct batch token, dedupes them, ' +
    'and performs one updateMany after all batches', async () => {
    const tokens = makeTokens(501);
    // Batch 1 (tokens 0-499): index 3 -> token-3 invalid.
    // Batch 2 (tokens 500): index 0 -> token-500 invalid.
    const sendEachForMulticast = jest
      .fn()
      .mockResolvedValueOnce({
        successCount: 499,
        failureCount: 1,
        responses: successResponses(500, { 3: 'messaging/registration-token-not-registered' }),
      })
      .mockResolvedValueOnce({
        successCount: 0,
        failureCount: 1,
        responses: successResponses(1, { 0: 'messaging/invalid-argument' }),
      });
    getMessaging.mockReturnValue({ sendEachForMulticast });
    const service = makeService();

    const result = await service.sendToTokens(tokens, CUSTOMER_PAYLOAD);

    expect(prisma.deviceToken.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.deviceToken.updateMany).toHaveBeenCalledWith({
      where: { token: { in: expect.arrayContaining(['token-3', 'token-500']) } },
      data: { isActive: false },
    });
    expect(
      (prisma.deviceToken.updateMany.mock.calls[0][0].where.token.in as string[]).sort(),
    ).toEqual(['token-3', 'token-500']);
    expect(result.invalidTokens.sort()).toEqual(['token-3', 'token-500']);
  });

  it('deduplicates an invalid token reported more than once', async () => {
    // Same physical device token appearing in the resolved list twice is
    // unrealistic in practice, but the aggregation itself must still dedupe
    // whatever ends up in the Set — cover it via two batches reporting the
    // same invalid token value.
    const tokens = [...makeTokens(500), 'token-0'];
    const sendEachForMulticast = jest
      .fn()
      .mockResolvedValueOnce({
        successCount: 499,
        failureCount: 1,
        responses: successResponses(500, { 0: 'messaging/invalid-argument' }),
      })
      .mockResolvedValueOnce({
        successCount: 0,
        failureCount: 1,
        responses: successResponses(1, { 0: 'messaging/invalid-argument' }),
      });
    getMessaging.mockReturnValue({ sendEachForMulticast });
    const service = makeService();

    const result = await service.sendToTokens(tokens, CUSTOMER_PAYLOAD);

    expect(result.invalidTokens).toEqual(['token-0']);
    expect(prisma.deviceToken.updateMany).toHaveBeenCalledTimes(1);
  });

  it('Firebase disabled: makes no Firebase call and reports every token as a failure', async () => {
    const tokens = makeTokens(600);
    const service = makeService(null);

    const result = await service.sendToTokens(tokens, CUSTOMER_PAYLOAD);

    expect(getMessaging).not.toHaveBeenCalled();
    expect(result).toEqual({ successCount: 0, failureCount: 600, invalidTokens: [] });
  });

  it('a later batch throwing is not swallowed: no false aggregate success, and no token ' +
    'values are logged', async () => {
    const tokens = makeTokens(501);
    const sendEachForMulticast = jest
      .fn()
      .mockResolvedValueOnce({ successCount: 500, failureCount: 0, responses: successResponses(500) })
      .mockRejectedValueOnce(new Error('FCM transport error'));
    getMessaging.mockReturnValue({ sendEachForMulticast });
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = makeService();

    await expect(service.sendToTokens(tokens, CUSTOMER_PAYLOAD)).rejects.toThrow(
      'FCM transport error',
    );

    expect(sendEachForMulticast).toHaveBeenCalledTimes(2);
    expect(prisma.deviceToken.updateMany).not.toHaveBeenCalled();
    const loggedMessages = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(loggedMessages.some((message) => message.includes('FCM transport error'))).toBe(true);
    tokens.forEach((token) => {
      loggedMessages.forEach((message) => expect(message).not.toContain(token));
    });

    errorSpy.mockRestore();
  });

  it('notification + data path (order/admin pushes) also batches correctly', async () => {
    const tokens = makeTokens(600);
    prisma.deviceToken.findMany.mockResolvedValue(tokens.map((token) => ({ token })));
    const sendEachForMulticast = jest
      .fn()
      .mockResolvedValueOnce({ successCount: 500, failureCount: 0, responses: successResponses(500) })
      .mockResolvedValueOnce({ successCount: 100, failureCount: 0, responses: successResponses(100) });
    getMessaging.mockReturnValue({ sendEachForMulticast });
    const service = makeService();

    const result = await service.sendAdminNewOrderNotification({
      notificationId: 'notif-1',
      orderId: 'order-1',
      orderNumber: 'ORD-1',
      customerName: 'Ahmed',
    });

    expect(sendEachForMulticast).toHaveBeenCalledTimes(2);
    expect(sendEachForMulticast.mock.calls[0][0]).toMatchObject({
      notification: { title: 'New order received' },
    });
    expect(sendEachForMulticast.mock.calls[0][0].tokens).toHaveLength(500);
    expect(sendEachForMulticast.mock.calls[1][0].tokens).toHaveLength(100);
    expect(result).toEqual({ successCount: 600, failureCount: 0, invalidTokens: [] });
  });

  it('sendOrderStatusNotification passes deliveryMethod into the payload builder, producing ' +
    'pickup-specific wording for a PICKUP order', async () => {
    prisma.deviceToken.findMany.mockResolvedValue([{ token: 'token-0' }]);
    const sendEachForMulticast = jest
      .fn()
      .mockResolvedValue({ successCount: 1, failureCount: 0, responses: successResponses(1) });
    getMessaging.mockReturnValue({ sendEachForMulticast });
    const service = makeService();

    await service.sendOrderStatusNotification({
      id: 'order-1',
      userId: 'user-1',
      status: 'OUT_FOR_DELIVERY',
      deliveryMethod: 'PICKUP',
    });

    expect(sendEachForMulticast.mock.calls[0][0].data).toMatchObject({
      type: 'order_ready',
      title: 'Order ready for pickup',
      body: 'Your order is ready to be collected.',
    });
  });

  it('sendOrderStatusNotification keeps delivery wording for a DELIVERY order', async () => {
    prisma.deviceToken.findMany.mockResolvedValue([{ token: 'token-0' }]);
    const sendEachForMulticast = jest
      .fn()
      .mockResolvedValue({ successCount: 1, failureCount: 0, responses: successResponses(1) });
    getMessaging.mockReturnValue({ sendEachForMulticast });
    const service = makeService();

    await service.sendOrderStatusNotification({
      id: 'order-1',
      userId: 'user-1',
      status: 'OUT_FOR_DELIVERY',
      deliveryMethod: 'DELIVERY',
    });

    expect(sendEachForMulticast.mock.calls[0][0].data).toMatchObject({
      type: 'order_out_for_delivery',
      title: 'Order out for delivery',
      body: 'Your order is on its way.',
    });
  });

  describe('APNs delivery configuration', () => {
    it('data-only send includes background push-type/priority and contentAvailable, ' +
      'with no aps.sound', async () => {
      const tokens = makeTokens(1);
      const sendEachForMulticast = jest
        .fn()
        .mockResolvedValue({ successCount: 1, failureCount: 0, responses: successResponses(1) });
      getMessaging.mockReturnValue({ sendEachForMulticast });
      const service = makeService();

      await service.sendToTokens(tokens, CUSTOMER_PAYLOAD);

      const sentMessage = sendEachForMulticast.mock.calls[0][0];
      expect(sentMessage.notification).toBeUndefined();
      expect(sentMessage.apns).toEqual({
        headers: {
          'apns-push-type': 'background',
          'apns-priority': '5',
        },
        payload: {
          aps: {
            contentAvailable: true,
          },
        },
      });
      expect(sentMessage.apns.payload.aps.sound).toBeUndefined();
    });

    it('notification+data send includes alert push-type/priority, contentAvailable, ' +
      'sound "default", and leaves the top-level notification/data payload unchanged', async () => {
      prisma.deviceToken.findMany.mockResolvedValue([{ token: 'token-0' }]);
      const sendEachForMulticast = jest
        .fn()
        .mockResolvedValue({ successCount: 1, failureCount: 0, responses: successResponses(1) });
      getMessaging.mockReturnValue({ sendEachForMulticast });
      const service = makeService();

      await service.sendAdminNewOrderNotification({
        notificationId: 'notif-1',
        orderId: 'order-1',
        orderNumber: 'ORD-1',
        customerName: 'Ahmed',
      });

      const sentMessage = sendEachForMulticast.mock.calls[0][0];
      expect(sentMessage.apns).toEqual({
        headers: {
          'apns-push-type': 'alert',
          'apns-priority': '10',
        },
        payload: {
          aps: {
            contentAvailable: true,
            sound: 'default',
          },
        },
      });
      expect(sentMessage.notification).toEqual({
        title: 'New order received',
        body: 'Ahmed placed order ORD-1',
      });
      expect(sentMessage.data).toEqual({
        type: 'NEW_ORDER',
        notificationId: 'notif-1',
        orderId: 'order-1',
        orderNumber: 'ORD-1',
      });
    });

    it('applies the APNs config to every batch when sending to 501+ tokens', async () => {
      const tokens = makeTokens(501);
      const sendEachForMulticast = jest
        .fn()
        .mockResolvedValueOnce({
          successCount: 500,
          failureCount: 0,
          responses: successResponses(500),
        })
        .mockResolvedValueOnce({ successCount: 1, failureCount: 0, responses: successResponses(1) });
      getMessaging.mockReturnValue({ sendEachForMulticast });
      const service = makeService();

      await service.sendToTokens(tokens, CUSTOMER_PAYLOAD);

      expect(sendEachForMulticast).toHaveBeenCalledTimes(2);
      const expectedApns = {
        headers: {
          'apns-push-type': 'background',
          'apns-priority': '5',
        },
        payload: {
          aps: {
            contentAvailable: true,
          },
        },
      };
      expect(sendEachForMulticast.mock.calls[0][0].apns).toEqual(expectedApns);
      expect(sendEachForMulticast.mock.calls[1][0].apns).toEqual(expectedApns);
    });
  });
});
