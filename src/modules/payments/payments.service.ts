import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Payment, PaymentStatus, Prisma, SavedCard } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { PaymentGatewayResult, PaymentProvider } from './payment-provider.interface';
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

export interface SavedCardResponseDto {
  id: string;
  brand: string;
  lastFour: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
  createdAt: string;
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

function toSavedCardResponse(card: SavedCard): SavedCardResponseDto {
  return {
    id: card.id,
    brand: card.brand,
    lastFour: card.lastFour,
    expMonth: card.expMonth,
    expYear: card.expYear,
    isDefault: card.isDefault,
    createdAt: card.createdAt.toISOString(),
  };
}

/**
 * Valid Payment.status transitions (plan §10.2, extended for Moyasar
 * authorize+capture/void — see moyasar-integration-plan memory).
 * VOIDED/FAILED/REFUNDED are terminal; CAPTURED can still be refunded later.
 */
const ALLOWED_PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  PENDING: ['AUTHORIZED', 'PAID', 'FAILED'],
  AUTHORIZED: ['CAPTURED', 'VOIDED', 'FAILED'],
  PAID: ['REFUNDED'],
  CAPTURED: ['REFUNDED'],
  VOIDED: [],
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

  /**
   * Called by the Flutter app after it creates the actual Moyasar payment
   * client-side (new-card flow — the SDK owns card entry + 3DS). Never
   * trusts the client's claimed result: `MoyasarProvider.confirm` re-fetches
   * the payment from Moyasar with the secret key before anything here is
   * persisted. Owner-only (404, not 403, if the order isn't theirs).
   */
  async confirmCardPayment(
    userId: string,
    orderId: string,
    providerPaymentId: string,
  ): Promise<PaymentResponseDto> {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, userId } });
    if (!order) {
      throw new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
    }
    const payment = await this.prisma.payment.findFirst({
      where: { orderId, method: 'CARD' },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) {
      throw new NotFoundException({ message: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
    }

    const provider = this.registry.getByMethod('CARD');
    if (!provider.confirm) {
      throw new BadRequestException({
        message: 'This payment provider does not support confirmation',
        code: 'CONFIRM_NOT_SUPPORTED',
      });
    }

    const result = await provider.confirm(order, payment, providerPaymentId);
    await this.recordGatewayResult(payment, result, provider);
    if (result.savedCard) {
      await this.persistSavedCard(userId, payment.id, result.savedCard);
    }

    const refreshed = await this.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    return toPaymentResponse(refreshed);
  }

  async listSavedCards(userId: string): Promise<SavedCardResponseDto[]> {
    const cards = await this.prisma.savedCard.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return cards.map(toSavedCardResponse);
  }

  /** Owner-only (404, not 403). Soft delete — Payment.savedCardId keeps pointing at the historical record. */
  async deleteSavedCard(userId: string, savedCardId: string): Promise<{ deleted: true }> {
    const card = await this.prisma.savedCard.findFirst({
      where: { id: savedCardId, userId, deletedAt: null },
    });
    if (!card) {
      throw new NotFoundException({
        message: 'Saved card not found',
        code: 'SAVED_CARD_NOT_FOUND',
      });
    }
    await this.prisma.savedCard.update({
      where: { id: savedCardId },
      data: { deletedAt: new Date() },
    });
    return { deleted: true };
  }

  /**
   * Backend-initiated saved-card charge (approved design decision — the
   * Flutter SDK is never involved for a repeat charge; only the rare
   * 3DS-on-token case needs a client-side WebView, driven by the returned
   * `transactionUrl`).
   */
  async chargeSavedCard(
    userId: string,
    orderId: string,
    savedCardId: string,
    cvc?: string,
  ): Promise<PaymentIntentResponseDto> {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, userId } });
    if (!order) {
      throw new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
    }
    const payment = await this.prisma.payment.findFirst({
      where: { orderId, method: 'CARD' },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) {
      throw new NotFoundException({ message: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
    }
    if (payment.status !== 'PENDING') {
      throw new ConflictException({
        message: `Payment already ${payment.status.toLowerCase()}`,
        code: 'PAYMENT_ALREADY_PROCESSED',
      });
    }
    const savedCard = await this.prisma.savedCard.findFirst({
      where: { id: savedCardId, userId, deletedAt: null },
    });
    if (!savedCard) {
      throw new NotFoundException({
        message: 'Saved card not found',
        code: 'SAVED_CARD_NOT_FOUND',
      });
    }

    const provider = this.registry.getByMethod('CARD');
    if (!provider.chargeWithSavedCard) {
      throw new BadRequestException({
        message: 'This payment provider does not support saved-card charges',
        code: 'SAVED_CARD_CHARGE_NOT_SUPPORTED',
      });
    }

    const result = await provider.chargeWithSavedCard(order, payment, savedCard, cvc);
    await this.recordGatewayResult(payment, result, provider, {
      savedCard: { connect: { id: savedCard.id } },
    });

    return {
      paymentId: payment.id,
      status: result.status,
      providerData: result.transactionUrl ? { transactionUrl: result.transactionUrl } : undefined,
    };
  }

  /**
   * Called by OrdersService BEFORE it allows a PENDING->CONFIRMED transition
   * to commit (the core business rule: never mark an order CONFIRMED before
   * its money is actually captured). No-op for non-CARD orders. Throws on
   * anything that should block the transition — an already-CAPTURED payment
   * is treated as already-done (idempotent retry), not an error.
   */
  async captureAuthorizedPayment(orderId: string): Promise<void> {
    const payment = await this.prisma.payment.findFirst({
      where: { orderId, method: 'CARD' },
      orderBy: { createdAt: 'desc' },
      include: { order: true },
    });
    if (!payment || payment.status === 'CAPTURED') {
      return;
    }
    if (payment.status !== 'AUTHORIZED') {
      throw new ConflictException({
        message: `Cannot accept this order — its payment is ${payment.status.toLowerCase()}, not authorized`,
        code: 'PAYMENT_NOT_AUTHORIZED',
      });
    }

    const provider = this.registry.getByMethod('CARD');
    if (!provider.capture) {
      throw new BadRequestException({
        message: 'This payment provider does not support capture',
        code: 'CAPTURE_NOT_SUPPORTED',
      });
    }
    const result = await provider.capture(payment.order, payment);
    const applied = await this.applyPaymentStatus(payment, {
      status: result.status,
      extra: result.status === 'CAPTURED' ? { capturedAt: new Date() } : {},
    });
    if (!applied || result.status !== 'CAPTURED') {
      throw new ConflictException({
        message: `Capture did not complete (gateway status: ${result.status})`,
        code: 'CAPTURE_INCOMPLETE',
      });
    }
  }

  /**
   * Called by OrdersService BEFORE it allows a PENDING->CANCELLED transition
   * to commit. Unlike capture, a non-AUTHORIZED payment is NOT an error —
   * rejecting an order that never completed payment must still succeed, so
   * this only acts (and can only fail) when there's an actual hold to release.
   */
  async voidAuthorizedPayment(orderId: string): Promise<void> {
    const payment = await this.prisma.payment.findFirst({
      where: { orderId, method: 'CARD' },
      orderBy: { createdAt: 'desc' },
      include: { order: true },
    });
    if (!payment || payment.status !== 'AUTHORIZED') {
      return;
    }

    const provider = this.registry.getByMethod('CARD');
    if (!provider.void) {
      throw new BadRequestException({
        message: 'This payment provider does not support void',
        code: 'VOID_NOT_SUPPORTED',
      });
    }
    const result = await provider.void(payment.order, payment);
    const applied = await this.applyPaymentStatus(payment, {
      status: result.status,
      extra: result.status === 'VOIDED' ? { voidedAt: new Date() } : {},
    });
    if (!applied || result.status !== 'VOIDED') {
      throw new ConflictException({
        message: `Void did not complete (gateway status: ${result.status})`,
        code: 'VOID_INCOMPLETE',
      });
    }
  }

  /**
   * Self-healing compensation: if `captureAuthorizedPayment` succeeded at
   * Moyasar but the order's own optimistic-concurrency CONFIRMED claim then
   * lost a race (a second admin action changed the order first), the
   * captured payment is orphaned from the order's actual state. This
   * attempts a compensating void (Moyasar allows voiding a captured payment
   * within ~2 hours) and never throws — called from a catch block that must
   * still surface the original conflict to the caller.
   */
  async compensateOrphanedCapture(orderId: string): Promise<void> {
    try {
      const payment = await this.prisma.payment.findFirst({
        where: { orderId, method: 'CARD', status: 'CAPTURED' },
        orderBy: { createdAt: 'desc' },
        include: { order: true },
      });
      if (!payment) {
        return;
      }
      const provider = this.registry.getByMethod('CARD');
      if (!provider.void) {
        return;
      }
      this.logger.error(
        `Order ${orderId} payment ${payment.id} was captured but its CONFIRMED transition lost a concurrency race — attempting a compensating void.`,
      );
      const result = await provider.void(payment.order, payment);
      await this.applyPaymentStatus(payment, {
        status: result.status,
        extra: result.status === 'VOIDED' ? { voidedAt: new Date() } : {},
      });
    } catch (error) {
      this.logger.error(
        `Compensating void FAILED for order ${orderId} — a captured payment is orphaned from its order state and needs MANUAL reconciliation: ${(error as Error).message}`,
      );
    }
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
   * Idempotent webhook processing (plan §10.2): route by provider name ->
   * verify signature -> parse -> apply via a status-guarded update so
   * concurrent/duplicate deliveries never double-apply.
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

    await this.applyPaymentStatus(payment, {
      status: parsed.status,
      extra: this.timestampFieldFor(parsed.status),
      rawWebhookJson: this.safeJson(rawBody),
    });
    return { received: true };
  }

  /**
   * COD settlement (plan §10.2: "marked PAID when delivered"). Called from
   * OrdersService after an order reaches a terminal-success status —
   * DELIVERED (DELIVERY) or PICKED_UP (PICKUP), Fix 12A; a no-op for
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
    await this.applyPaymentStatus(payment, { status: 'PAID' });
  }

  /**
   * Persists a gateway result that may or may not have reached a final
   * status yet: Moyasar's `initiated` (3DS challenge pending) maps to our
   * PENDING — in that case only providerRef/provider are recorded (no status
   * transition), so the eventual webhook or a later confirm call can still
   * find this payment. A final status goes through the guarded transition
   * table via `applyPaymentStatus`.
   */
  private async recordGatewayResult(
    payment: Payment,
    result: PaymentGatewayResult,
    provider: PaymentProvider,
    extraOnFinal: Prisma.PaymentUpdateInput = {},
  ): Promise<void> {
    if (result.status === 'PENDING') {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { provider: provider.name, providerRef: result.providerRef },
      });
      return;
    }
    await this.applyPaymentStatus(payment, {
      status: result.status,
      providerRef: result.providerRef,
      provider: provider.name,
      extra: { ...this.timestampFieldFor(result.status), ...extraOnFinal },
    });
  }

  /**
   * Guarded status transition shared by webhook/confirm/capture/void: only
   * applies (and only claims via `updateMany` guarded on the row's current
   * status) when the transition is valid and hasn't already been applied —
   * concurrent/duplicate callers racing the same transition never double-apply.
   * Returns whether the write was actually claimed by this call.
   */
  private async applyPaymentStatus(
    payment: Payment,
    next: {
      status: PaymentStatus;
      providerRef?: string;
      provider?: string;
      extra?: Prisma.PaymentUpdateInput;
      rawWebhookJson?: Prisma.InputJsonValue;
    },
  ): Promise<boolean> {
    if (payment.status === next.status) {
      return true; // Duplicate delivery / already-applied — safe no-op.
    }
    if (!ALLOWED_PAYMENT_TRANSITIONS[payment.status].includes(next.status)) {
      this.logger.warn(
        `Ignored invalid payment transition ${payment.status} -> ${next.status} for payment ${payment.id}`,
      );
      return false;
    }

    const claimed = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: payment.status },
      data: {
        status: next.status,
        ...(next.providerRef ? { providerRef: next.providerRef } : {}),
        ...(next.provider ? { provider: next.provider } : {}),
        ...(next.rawWebhookJson ? { rawWebhookJson: next.rawWebhookJson } : {}),
        ...next.extra,
      },
    });
    if (claimed.count !== 1) {
      return false;
    }
    await this.prisma.order.update({
      where: { id: payment.orderId },
      data: { paymentStatus: next.status },
    });
    return true;
  }

  private timestampFieldFor(status: PaymentStatus): Prisma.PaymentUpdateInput {
    if (status === 'AUTHORIZED') return { authorizedAt: new Date() };
    if (status === 'CAPTURED') return { capturedAt: new Date() };
    if (status === 'VOIDED') return { voidedAt: new Date() };
    return {};
  }

  private async persistSavedCard(
    userId: string,
    paymentId: string,
    savedCard: NonNullable<PaymentGatewayResult['savedCard']>,
  ): Promise<void> {
    const record = await this.prisma.savedCard.upsert({
      where: { token: savedCard.token },
      create: {
        userId,
        provider: 'moyasar',
        token: savedCard.token,
        brand: savedCard.brand,
        lastFour: savedCard.lastFour,
        expMonth: savedCard.expMonth,
        expYear: savedCard.expYear,
        status: savedCard.status,
      },
      update: {
        brand: savedCard.brand,
        lastFour: savedCard.lastFour,
        expMonth: savedCard.expMonth,
        expYear: savedCard.expYear,
        status: savedCard.status,
        deletedAt: null,
      },
    });
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { savedCardId: record.id },
    });
  }

  private safeJson(rawBody: string): Prisma.InputJsonValue {
    try {
      return JSON.parse(rawBody) as Prisma.InputJsonValue;
    } catch {
      return { raw: rawBody };
    }
  }
}
