import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MoyasarProvider } from './moyasar.provider';
import { MoyasarApiError, MoyasarClientService } from '../moyasar/moyasar-client.service';

const D = (v: string | number) => new Prisma.Decimal(v);

function makeConfig(values: Record<string, string | undefined>) {
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

const order = { id: 'order-1', orderNumber: 'KZ-260811-abcd', totalAmount: D('150.00') } as never;
const payment = {
  id: 'payment-1',
  orderId: 'order-1',
  amount: D('150.00'),
  currency: 'SAR',
  status: 'AUTHORIZED',
  providerRef: 'pay_moyasar_1',
} as never;

describe('MoyasarProvider', () => {
  let moyasar: {
    fetchPayment: jest.Mock;
    capturePayment: jest.Mock;
    voidPayment: jest.Mock;
    createPaymentWithToken: jest.Mock;
  };
  let provider: MoyasarProvider;

  beforeEach(() => {
    moyasar = {
      fetchPayment: jest.fn(),
      capturePayment: jest.fn(),
      voidPayment: jest.fn(),
      createPaymentWithToken: jest.fn(),
    };
    provider = new MoyasarProvider(
      moyasar as unknown as MoyasarClientService,
      makeConfig({
        'moyasar.webhookSecret': 'whsec_test',
        'moyasar.publishableKey': 'pk_test_abc',
        'uploads.publicBaseUrl': 'https://api.kebdazaman.cloud',
      }),
    );
  });

  describe('verifyWebhook', () => {
    it('accepts a payload whose secret_token matches the configured webhook secret', () => {
      const body = JSON.stringify({ secret_token: 'whsec_test', data: { id: 'pay_1' } });
      expect(provider.verifyWebhook({}, body)).toEqual({ valid: true });
    });

    it('rejects a payload with the wrong secret_token', () => {
      const body = JSON.stringify({ secret_token: 'wrong', data: { id: 'pay_1' } });
      expect(provider.verifyWebhook({}, body).valid).toBe(false);
    });

    it('rejects malformed JSON', () => {
      expect(provider.verifyWebhook({}, '{not json').valid).toBe(false);
    });
  });

  describe('parseWebhook', () => {
    it('maps a payment_captured event to CAPTURED', () => {
      const body = JSON.stringify({
        type: 'payment_captured',
        data: { id: 'pay_moyasar_1', status: 'captured', amount: 15000 },
      });
      expect(provider.parseWebhook(body)).toEqual({
        providerRef: 'pay_moyasar_1',
        status: 'CAPTURED',
        amount: '15000',
      });
    });

    it('maps every Moyasar status to the matching PaymentStatus', () => {
      const cases: Array<[string, string]> = [
        ['authorized', 'AUTHORIZED'],
        ['captured', 'CAPTURED'],
        ['voided', 'VOIDED'],
        ['paid', 'PAID'],
        ['refunded', 'REFUNDED'],
        ['failed', 'FAILED'],
        ['initiated', 'PENDING'],
      ];
      for (const [moyasarStatus, expected] of cases) {
        const body = JSON.stringify({ data: { id: 'pay_1', status: moyasarStatus, amount: 100 } });
        expect(provider.parseWebhook(body).status).toBe(expected);
      }
    });
  });

  describe('confirm', () => {
    it('accepts when the fetched amount/currency/orderId all match', async () => {
      moyasar.fetchPayment.mockResolvedValue({
        id: 'pay_moyasar_1',
        status: 'authorized',
        amount: 15000,
        currency: 'SAR',
        source: {},
        metadata: { orderId: 'order-1' },
      });

      const result = await provider.confirm(order, payment, 'pay_moyasar_1');
      expect(result).toMatchObject({ providerRef: 'pay_moyasar_1', status: 'AUTHORIZED' });
    });

    it('rejects when the fetched amount does not match the order', async () => {
      moyasar.fetchPayment.mockResolvedValue({
        id: 'pay_moyasar_1',
        status: 'authorized',
        amount: 99900,
        currency: 'SAR',
        source: {},
      });

      await expect(provider.confirm(order, payment, 'pay_moyasar_1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects when the payment metadata points at a different order', async () => {
      moyasar.fetchPayment.mockResolvedValue({
        id: 'pay_moyasar_1',
        status: 'authorized',
        amount: 15000,
        currency: 'SAR',
        source: {},
        metadata: { orderId: 'some-other-order' },
      });

      await expect(provider.confirm(order, payment, 'pay_moyasar_1')).rejects.toMatchObject({
        response: { code: 'PAYMENT_VERIFICATION_FAILED' },
      });
    });
  });

  describe('capture / void', () => {
    it('capture calls Moyasar with the stored providerRef and maps the result', async () => {
      moyasar.capturePayment.mockResolvedValue({
        id: 'pay_moyasar_1',
        status: 'captured',
        source: {},
      });

      const result = await provider.capture(order, payment);

      expect(moyasar.capturePayment).toHaveBeenCalledWith('pay_moyasar_1');
      expect(result.status).toBe('CAPTURED');
    });

    it('void calls Moyasar with the stored providerRef and maps the result', async () => {
      moyasar.voidPayment.mockResolvedValue({ id: 'pay_moyasar_1', status: 'voided', source: {} });

      const result = await provider.void(order, payment);

      expect(moyasar.voidPayment).toHaveBeenCalledWith('pay_moyasar_1');
      expect(result.status).toBe('VOIDED');
    });

    it('never leaks the raw Moyasar error body — surfaces a generic gateway error instead', async () => {
      moyasar.capturePayment.mockRejectedValue(
        new MoyasarApiError(400, {
          message: 'Capture amount cannot exceed the authorized amount.',
        }),
      );

      await expect(provider.capture(order, payment)).rejects.toMatchObject({
        response: { code: 'MOYASAR_API_ERROR' },
      });
    });
  });

  describe('chargeWithSavedCard', () => {
    it('charges with manual:true and reuses payment.id as the idempotency given_id', async () => {
      moyasar.createPaymentWithToken.mockResolvedValue({
        id: 'pay_moyasar_2',
        status: 'authorized',
        source: {},
      });

      await provider.chargeWithSavedCard(order, payment, { token: 'token_abc' }, '123');

      expect(moyasar.createPaymentWithToken).toHaveBeenCalledWith(
        expect.objectContaining({
          givenId: 'payment-1',
          token: 'token_abc',
          cvc: '123',
          manual: true,
        }),
      );
    });
  });
});
