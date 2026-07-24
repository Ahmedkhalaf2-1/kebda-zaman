import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Payment, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { CreateIntentDto } from './dto/create-intent.dto';

export interface PaymentResponseDto {
  id: string;
  orderId: string;
  method: string;
  status: PaymentStatus;
  amount: number;
  currency: string;
  provider: string | null;
  providerRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentIntentResponseDto {
  paymentId: string;
  status: PaymentStatus;
  providerData?: Record<string, unknown>;
}

function toPaymentResponse(payment: Payment): PaymentResponseDto {
  return {
    id: payment.id,
    orderId: payment.orderId,
    method: payment.method,
    status: payment.status,
    amount: payment.amount.toNumber(),
    currency: payment.currency,
    provider: payment.provider,
    providerRef: payment.providerRef,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}

/** Valid Payment.status transitions (plan §10.2). FAILED/REFUNDED are terminal. */
const ALLOWED_PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  PENDING: ['PAID', 'FAILED'],
  PAID: ['REFUNDED'],
  FAILED: [],
  REFUNDED: [],
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PaymentProviderRegistry,
  ) {}

  /**
   * Never trusts a client amount — operates only on the Payment row already
   * created (with authoritative totals) at checkout (Phase 5). Repeated
   * calls while still PENDING are safe: no duplicate Payment row is ever
   * created here.
   */
  async createIntent(userId: string, dto: CreateIntentDto): Promise<PaymentIntentResponseDto> {
    const order = await this.prisma.order.findFirst({ where: { id: dto.orderId, userId } });
    if (!order) {
      throw new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
    }
    const payment = await this.prisma.payment.findFirst({
      where: { orderId: order.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) {
      throw new NotFoundException({
        message: 'Payment not found for this order',
        code: 'PAYMENT_NOT_FOUND',
      });
    }
    if (payment.status !== 'PENDING') {
      throw new ConflictException({
        message: `Payment already ${payment.status.toLowerCase()}`,
        code: 'PAYMENT_ALREADY_PROCESSED',
      });
    }

    const provider = this.registry.getByMethod(payment.method);
    const result = await provider.createIntent(order, payment);

    if (result.providerRef && result.providerRef !== payment.providerRef) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { provider: provider.name, providerRef: result.providerRef },
      });
    } else if (!payment.provider) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { provider: provider.name },
      });
    }

    return { paymentId: payment.id, status: result.status, providerData: result.clientData };
  }

  /** Owner or ADMIN; a non-owner gets 404 (not 403) so payment existence isn't leaked. */
  async getPayment(caller: AuthenticatedUser, paymentId: string): Promise<PaymentResponseDto> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: true },
    });
    if (!payment || (caller.role !== 'ADMIN' && payment.order.userId !== caller.id)) {
      throw new NotFoundException({ message: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
    }
    return toPaymentResponse(payment);
  }

  /**
   * Idempotent webhook processing foundation (plan §10.2): route by
   * provider name -> verify signature -> parse -> apply via a
   * status-guarded update so concurrent/duplicate deliveries never
   * double-apply. No real gateway is registered yet, so every provider name
   * currently resolves to either "unknown" or a provider whose
   * `verifyWebhook` always reports invalid — this endpoint never fakes a
   * successful payment.
   */
  async processWebhook(
    providerName: string,
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<{ received: true }> {
    const provider = this.registry.getByName(providerName);
    if (!provider) {
      throw new BadRequestException({
        message: `Unknown payment provider: ${providerName}`,
        code: 'UNKNOWN_PAYMENT_PROVIDER',
      });
    }

    const verification = provider.verifyWebhook(headers, rawBody);
    if (!verification.valid) {
      throw new BadRequestException({
        message: verification.reason ?? 'Invalid webhook signature',
        code: 'INVALID_WEBHOOK_SIGNATURE',
      });
    }

    const parsed = provider.parseWebhook(rawBody);

    const payment = await this.prisma.payment.findFirst({
      where: { providerRef: parsed.providerRef },
    });
    if (!payment) {
      throw new NotFoundException({
        message: 'Payment not found for providerRef',
        code: 'PAYMENT_NOT_FOUND',
      });
    }

    if (payment.status === parsed.status) {
      return { received: true }; // Duplicate delivery of an already-applied event.
    }
    if (!ALLOWED_PAYMENT_TRANSITIONS[payment.status].includes(parsed.status)) {
      this.logger.warn(
        `Webhook for payment ${payment.id} attempted invalid transition ${payment.status} -> ${parsed.status}; ignored`,
      );
      return { received: true };
    }

    // Guarded on the status read above: if two deliveries race, only one wins.
    const claimed = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: payment.status },
      data: { status: parsed.status, rawWebhookJson: this.safeJson(rawBody) },
    });
    if (claimed.count === 1) {
      await this.prisma.order.update({
        where: { id: payment.orderId },
        data: { paymentStatus: parsed.status },
      });
    }
    return { received: true };
  }

  /**
   * COD settlement (plan §10.2: "marked PAID when delivered"). Called from
   * OrdersService after a DELIVERED transition commits; a no-op for
   * CARD/WALLET or a payment that isn't PENDING.
   */
  async settleCashOnDelivery(orderId: string): Promise<void> {
    const payment = await this.prisma.payment.findFirst({
      where: { orderId, method: 'CASH', status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) {
      return;
    }
    const claimed = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: 'PENDING' },
      data: { status: 'PAID' },
    });
    if (claimed.count === 1) {
      await this.prisma.order.update({ where: { id: orderId }, data: { paymentStatus: 'PAID' } });
    }
  }

  private safeJson(rawBody: string): Prisma.InputJsonValue {
    try {
      return JSON.parse(rawBody) as Prisma.InputJsonValue;
    } catch {
      return { raw: rawBody };
    }
  }
}
