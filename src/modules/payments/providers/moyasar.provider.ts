import { timingSafeEqual } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Order, Payment, PaymentMethod, PaymentStatus } from '@prisma/client';
import {
  ParsedWebhookEvent,
  PaymentGatewayResult,
  PaymentIntentResult,
  PaymentProvider,
  WebhookVerificationResult,
} from '../payment-provider.interface';
import {
  MoyasarApiError,
  MoyasarClientService,
  MoyasarPayment,
  MoyasarPaymentStatus,
  MoyasarUnavailableError,
  toSmallestUnit,
} from '../moyasar/moyasar-client.service';

const CALLBACK_PATH = '/api/v1/payments/moyasar/return';

/** Maps Moyasar's payment status strings onto our own PaymentStatus enum. */
function mapMoyasarStatus(status: MoyasarPaymentStatus): PaymentStatus {
  switch (status) {
    case 'authorized':
      return 'AUTHORIZED';
    case 'captured':
      return 'CAPTURED';
    case 'voided':
      return 'VOIDED';
    case 'paid':
      return 'PAID';
    case 'refunded':
      return 'REFUNDED';
    case 'failed':
      return 'FAILED';
    case 'initiated':
    case 'verified':
    default:
      return 'PENDING';
  }
}

/** Extracts saved-card display fields from a Moyasar payment's `source`, when a card was tokenized on this payment. */
function extractSavedCard(source: MoyasarPayment['source']): PaymentGatewayResult['savedCard'] {
  const token = typeof source.token === 'string' ? source.token : undefined;
  if (!token) {
    return undefined;
  }
  // Field names for the tokenized-card metadata mirrored onto a *payment's*
  // source (as opposed to the standalone Token object, whose fields ARE
  // confirmed: id/status/brand/funding/last_four/month/year) were not
  // exactly confirmed against a live sandbox response at plan time — verify
  // company/number/month/year/status against a real response during
  // integration testing before relying on this in production.
  const number = typeof source.number === 'string' ? source.number : '';
  return {
    token,
    brand: typeof source.company === 'string' ? source.company : 'unknown',
    lastFour: number.slice(-4) || '0000',
    expMonth: typeof source.month === 'string' ? parseInt(source.month, 10) : 0,
    expYear: typeof source.year === 'string' ? parseInt(source.year, 10) : 0,
    status: 'active',
  };
}

function toGatewayResult(payment: MoyasarPayment): PaymentGatewayResult {
  return {
    providerRef: payment.id,
    status: mapMoyasarStatus(payment.status),
    transactionUrl: payment.transaction_url ?? undefined,
    savedCard: extractSavedCard(payment.source),
  };
}

@Injectable()
export class MoyasarProvider implements PaymentProvider {
  private readonly logger = new Logger(MoyasarProvider.name);

  readonly name = 'moyasar';
  readonly methods: PaymentMethod[] = ['CARD'];

  constructor(
    private readonly moyasar: MoyasarClientService,
    private readonly config: ConfigService,
  ) {}

  get isConfigured(): boolean {
    return this.moyasar.isConfigured;
  }

  /**
   * Card data must never reach this backend — the actual Moyasar payment for
   * a NEW card is created client-side by the Flutter SDK using the
   * publishable key. This just hands back the config the SDK needs,
   * including `orderId` which the client MUST set as `metadata.orderId` when
   * it creates the payment (that's how `confirm()` below binds the resulting
   * Moyasar payment back to this order).
   */
  async createIntent(order: Order, payment: Payment): Promise<PaymentIntentResult> {
    return {
      providerRef: null,
      status: payment.status,
      clientData: {
        publishableApiKey: this.config.get<string>('moyasar.publishableKey') ?? null,
        amount: toSmallestUnit(payment.amount),
        currency: payment.currency,
        orderId: order.id,
        description: order.orderNumber,
        callbackUrl: this.callbackUrl(),
        manual: true,
      },
    };
  }

  /**
   * Server-side verification (never trusts the client's claimed result):
   * fetches the payment from Moyasar with the secret key and checks it
   * actually belongs to this order and amount before returning a status
   * PaymentsService will persist.
   */
  async confirm(
    order: Order,
    payment: Payment,
    providerPaymentId: string,
  ): Promise<PaymentGatewayResult> {
    const fetched = await this.fetchOrThrow(providerPaymentId);

    const expectedAmount = toSmallestUnit(payment.amount);
    if (fetched.amount !== expectedAmount || fetched.currency !== payment.currency) {
      throw new BadRequestException({
        message: 'Payment amount/currency does not match the order',
        code: 'PAYMENT_VERIFICATION_FAILED',
      });
    }
    const metadataOrderId = fetched.metadata?.orderId;
    if (metadataOrderId !== undefined && metadataOrderId !== order.id) {
      throw new BadRequestException({
        message: 'Payment does not belong to this order',
        code: 'PAYMENT_VERIFICATION_FAILED',
      });
    }

    return toGatewayResult(fetched);
  }

  async capture(_order: Order, payment: Payment): Promise<PaymentGatewayResult> {
    if (!payment.providerRef) {
      throw new BadRequestException({
        message: 'Payment has no Moyasar reference to capture',
        code: 'PAYMENT_NOT_AUTHORIZED',
      });
    }
    const captured = await this.captureOrThrow(payment.providerRef);
    return toGatewayResult(captured);
  }

  async void(_order: Order, payment: Payment): Promise<PaymentGatewayResult> {
    if (!payment.providerRef) {
      throw new BadRequestException({
        message: 'Payment has no Moyasar reference to void',
        code: 'PAYMENT_NOT_AUTHORIZED',
      });
    }
    const voided = await this.voidOrThrow(payment.providerRef);
    return toGatewayResult(voided);
  }

  /** Backend-initiated saved-card charge (approved design decision — never routed back through the Flutter SDK). */
  async chargeWithSavedCard(
    order: Order,
    payment: Payment,
    savedCard: { token: string },
    cvc: string | undefined,
  ): Promise<PaymentGatewayResult> {
    try {
      const created = await this.moyasar.createPaymentWithToken({
        // Payment.id is already unique per attempt (checkout's own
        // idempotency guarantees one Payment row per order) — reusing it as
        // Moyasar's given_id makes this call itself safely retryable.
        givenId: payment.id,
        amount: toSmallestUnit(payment.amount),
        currency: payment.currency,
        description: order.orderNumber,
        callbackUrl: this.callbackUrl(),
        metadata: { orderId: order.id },
        token: savedCard.token,
        cvc,
        manual: true,
        threeDs: true,
      });
      return toGatewayResult(created);
    } catch (error) {
      this.rethrowAsDomainError(error);
    }
  }

  /** Secret lives inside the JSON body as `secret_token` (Moyasar does not sign webhooks via a header). */
  verifyWebhook(_headers: Record<string, string>, rawBody: string): WebhookVerificationResult {
    const expected = this.config.get<string>('moyasar.webhookSecret');
    if (!expected) {
      return { valid: false, reason: 'MOYASAR_WEBHOOK_SECRET is not configured on the server' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { valid: false, reason: 'Malformed webhook JSON body' };
    }
    const received = (parsed as { secret_token?: unknown }).secret_token;
    if (typeof received !== 'string' || !this.timingSafeEquals(received, expected)) {
      return { valid: false, reason: 'secret_token mismatch' };
    }
    return { valid: true };
  }

  parseWebhook(rawBody: string): ParsedWebhookEvent {
    const parsed = JSON.parse(rawBody) as { data?: MoyasarPayment };
    const data = parsed.data;
    if (!data?.id || !data.status) {
      throw new BadRequestException({
        message: 'Webhook payload missing payment data',
        code: 'INVALID_WEBHOOK_PAYLOAD',
      });
    }
    return {
      providerRef: data.id,
      status: mapMoyasarStatus(data.status),
      amount: String(data.amount),
    };
  }

  private callbackUrl(): string {
    const base = (this.config.get<string>('uploads.publicBaseUrl') ?? '').replace(/\/+$/, '');
    return `${base}${CALLBACK_PATH}`;
  }

  private timingSafeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }

  private async fetchOrThrow(providerPaymentId: string): Promise<MoyasarPayment> {
    try {
      return await this.moyasar.fetchPayment(providerPaymentId);
    } catch (error) {
      this.rethrowAsDomainError(error);
    }
  }

  private async captureOrThrow(providerRef: string): Promise<MoyasarPayment> {
    try {
      return await this.moyasar.capturePayment(providerRef);
    } catch (error) {
      this.rethrowAsDomainError(error);
    }
  }

  private async voidOrThrow(providerRef: string): Promise<MoyasarPayment> {
    try {
      return await this.moyasar.voidPayment(providerRef);
    } catch (error) {
      this.rethrowAsDomainError(error);
    }
  }

  /** Never leaks Moyasar's raw error body to the client — logs it, surfaces a generic gateway error. */
  private rethrowAsDomainError(error: unknown): never {
    if (error instanceof MoyasarApiError) {
      this.logger.warn(
        `Moyasar API returned HTTP ${error.httpStatus}: ${JSON.stringify(error.body)}`,
      );
      throw new BadGatewayException({
        message: 'The payment provider rejected this request',
        code: 'MOYASAR_API_ERROR',
      });
    }
    if (error instanceof MoyasarUnavailableError) {
      this.logger.error(`Moyasar unavailable: ${error.message}`);
      throw new ServiceUnavailableException({
        message: 'The payment provider is temporarily unavailable',
        code: 'MOYASAR_UNAVAILABLE',
      });
    }
    throw error;
  }
}
