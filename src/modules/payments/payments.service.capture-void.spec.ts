import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentProviderRegistry } from './payment-provider.registry';

const D = (v: string | number) => new Prisma.Decimal(v);

const orderFixture = { id: 'order-1', totalAmount: D('150.00') };

function paymentFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'payment-1',
    orderId: 'order-1',
    method: 'CARD',
    status: 'AUTHORIZED',
    amount: D('150.00'),
    currency: 'SAR',
    provider: 'moyasar',
    providerRef: 'pay_moyasar_1',
    order: orderFixture,
    ...overrides,
  };
}

describe('PaymentsService — capture/void gating', () => {
  let prisma: {
    payment: {
      findFirst: jest.Mock;
      updateMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
    order: { update: jest.Mock };
    savedCard: { upsert: jest.Mock };
  };
  let registry: { getByMethod: jest.Mock };
  let provider: { capture: jest.Mock; void: jest.Mock; confirm: jest.Mock; name: string };
  let service: PaymentsService;

  beforeEach(() => {
    prisma = {
      payment: {
        findFirst: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      order: { update: jest.fn() },
      savedCard: { upsert: jest.fn() },
    };
    provider = {
      capture: jest.fn(),
      void: jest.fn(),
      confirm: jest.fn(),
      name: 'moyasar',
    };
    registry = { getByMethod: jest.fn().mockReturnValue(provider) };
    service = new PaymentsService(
      prisma as unknown as PrismaService,
      registry as unknown as PaymentProviderRegistry,
    );
  });

  describe('captureAuthorizedPayment', () => {
    it('captures an AUTHORIZED payment and mirrors CAPTURED onto the order', async () => {
      prisma.payment.findFirst.mockResolvedValue(paymentFixture());
      provider.capture.mockResolvedValue({ providerRef: 'pay_moyasar_1', status: 'CAPTURED' });

      await service.captureAuthorizedPayment('order-1');

      expect(provider.capture).toHaveBeenCalledWith(
        orderFixture,
        expect.objectContaining({ id: 'payment-1' }),
      );
      expect(prisma.payment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'payment-1', status: 'AUTHORIZED' },
          data: expect.objectContaining({ status: 'CAPTURED' }),
        }),
      );
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: { paymentStatus: 'CAPTURED' },
      });
    });

    it('throws and never calls the gateway when the payment is not AUTHORIZED (blocks the order transition)', async () => {
      prisma.payment.findFirst.mockResolvedValue(paymentFixture({ status: 'PENDING' }));

      await expect(service.captureAuthorizedPayment('order-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(provider.capture).not.toHaveBeenCalled();
    });

    it('is a no-op (idempotent) when the payment is already CAPTURED', async () => {
      prisma.payment.findFirst.mockResolvedValue(paymentFixture({ status: 'CAPTURED' }));

      await expect(service.captureAuthorizedPayment('order-1')).resolves.toBeUndefined();
      expect(provider.capture).not.toHaveBeenCalled();
    });

    it('is a no-op for a non-CARD order (no Payment row found for method CARD)', async () => {
      prisma.payment.findFirst.mockResolvedValue(null);

      await expect(service.captureAuthorizedPayment('order-1')).resolves.toBeUndefined();
      expect(provider.capture).not.toHaveBeenCalled();
    });

    it('throws when the gateway reports capture did not complete', async () => {
      prisma.payment.findFirst.mockResolvedValue(paymentFixture());
      provider.capture.mockResolvedValue({ providerRef: 'pay_moyasar_1', status: 'FAILED' });

      await expect(service.captureAuthorizedPayment('order-1')).rejects.toMatchObject({
        response: { code: 'CAPTURE_INCOMPLETE' },
      });
    });
  });

  describe('voidAuthorizedPayment', () => {
    it('voids an AUTHORIZED payment and mirrors VOIDED onto the order', async () => {
      prisma.payment.findFirst.mockResolvedValue(paymentFixture());
      provider.void.mockResolvedValue({ providerRef: 'pay_moyasar_1', status: 'VOIDED' });

      await service.voidAuthorizedPayment('order-1');

      expect(provider.void).toHaveBeenCalled();
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: { paymentStatus: 'VOIDED' },
      });
    });

    it('does NOT throw and never calls the gateway when there is nothing to void (reject must still succeed)', async () => {
      prisma.payment.findFirst.mockResolvedValue(paymentFixture({ status: 'PENDING' }));

      await expect(service.voidAuthorizedPayment('order-1')).resolves.toBeUndefined();
      expect(provider.void).not.toHaveBeenCalled();
    });
  });

  describe('compensateOrphanedCapture', () => {
    it('voids a CAPTURED payment and never throws even if the compensating void itself fails', async () => {
      prisma.payment.findFirst.mockResolvedValue(paymentFixture({ status: 'CAPTURED' }));
      provider.void.mockRejectedValue(new Error('gateway down'));

      await expect(service.compensateOrphanedCapture('order-1')).resolves.toBeUndefined();
      expect(provider.void).toHaveBeenCalled();
    });
  });
});
