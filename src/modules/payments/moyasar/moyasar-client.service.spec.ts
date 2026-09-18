import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  MoyasarApiError,
  MoyasarClientService,
  MoyasarUnavailableError,
  toSmallestUnit,
} from './moyasar-client.service';

function makeConfig(secretKey: string | undefined, nodeEnv = 'test') {
  return {
    get: jest.fn((key: string) => {
      if (key === 'moyasar.secretKey') return secretKey;
      if (key === 'nodeEnv') return nodeEnv;
      return undefined;
    }),
  } as unknown as ConfigService;
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('MoyasarClientService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('sends HTTP Basic Auth with the secret key as username and a blank password', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { id: 'pay_1', status: 'authorized' }));
    const client = new MoyasarClientService(makeConfig('sk_test_abc'));

    await client.fetchPayment('pay_1');

    const [url, requestInit] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.moyasar.com/v1/payments/pay_1');
    const expectedAuth = `Basic ${Buffer.from('sk_test_abc:').toString('base64')}`;
    expect(requestInit.headers.Authorization).toBe(expectedAuth);
  });

  it('throws MoyasarUnavailableError without calling the network when the secret key is unset', async () => {
    global.fetch = jest.fn();
    const client = new MoyasarClientService(makeConfig(undefined));

    await expect(client.fetchPayment('pay_1')).rejects.toBeInstanceOf(MoyasarUnavailableError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws MoyasarApiError with the HTTP status and body on a non-2xx response', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse(400, { message: 'Payment is already created.' }));
    const client = new MoyasarClientService(makeConfig('sk_test_abc'));

    await expect(client.capturePayment('pay_1')).rejects.toBeInstanceOf(MoyasarApiError);
    await expect(client.capturePayment('pay_1')).rejects.toMatchObject({
      httpStatus: 400,
      body: { message: 'Payment is already created.' },
    });
  });

  it('maps a network/timeout failure to MoyasarUnavailableError', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    const client = new MoyasarClientService(makeConfig('sk_test_abc'));

    await expect(client.voidPayment('pay_1')).rejects.toBeInstanceOf(MoyasarUnavailableError);
  });

  it('sends capture with no body for a full capture, and an amount for a partial capture', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { id: 'pay_1', status: 'captured' }));
    const client = new MoyasarClientService(makeConfig('sk_test_abc'));

    await client.capturePayment('pay_1');
    expect((global.fetch as jest.Mock).mock.calls[0][1].body).toBeUndefined();

    await client.capturePayment('pay_1', 5000);
    expect((global.fetch as jest.Mock).mock.calls[1][1].body).toBe(
      JSON.stringify({ amount: 5000 }),
    );
  });

  it('sends a token source with manual:true and 3ds when creating a payment with a saved card', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { id: 'pay_1', status: 'authorized' }));
    const client = new MoyasarClientService(makeConfig('sk_test_abc'));

    await client.createPaymentWithToken({
      givenId: 'payment-row-id',
      amount: 15000,
      currency: 'SAR',
      callbackUrl: 'https://api.kebdazaman.cloud/api/v1/payments/moyasar/return',
      metadata: { orderId: 'order-1' },
      token: 'token_abc',
      manual: true,
      threeDs: true,
    });

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.given_id).toBe('payment-row-id');
    expect(body.source).toEqual({
      type: 'token',
      token: 'token_abc',
      cvc: undefined,
      manual: true,
      '3ds': true,
    });
  });
});

describe('toSmallestUnit', () => {
  it('converts SAR major units to halalas', () => {
    expect(toSmallestUnit(new Prisma.Decimal('150.00'))).toBe(15000);
    expect(toSmallestUnit(new Prisma.Decimal('99.99'))).toBe(9999);
    expect(toSmallestUnit(new Prisma.Decimal('0.5'))).toBe(50);
  });
});
