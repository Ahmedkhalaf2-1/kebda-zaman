import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';

const MOYASAR_API_BASE = 'https://api.moyasar.com/v1';
const REQUEST_TIMEOUT_MS = 10000;

/** Payment/token status strings as returned by Moyasar (docs.moyasar.com). */
export type MoyasarPaymentStatus =
  'initiated' | 'paid' | 'authorized' | 'failed' | 'refunded' | 'captured' | 'voided' | 'verified';

export interface MoyasarPaymentSource {
  type: string;
  company?: string;
  name?: string;
  number?: string;
  message?: string;
  token?: string;
  gateway_id?: string;
  reference_number?: string | null;
  [key: string]: unknown;
}

export interface MoyasarPayment {
  id: string;
  status: MoyasarPaymentStatus;
  amount: number;
  fee: number;
  currency: string;
  captured: number;
  refunded: number;
  description?: string | null;
  callback_url?: string | null;
  transaction_url?: string | null;
  created_at: string;
  updated_at: string;
  source: MoyasarPaymentSource;
  metadata?: Record<string, unknown> | null;
}

/**
 * Charging a saved card (backend-initiated, per the approved plan — never a
 * fresh `creditcard` source here: raw card data must never reach this
 * backend, only a Moyasar-issued token already on file).
 */
export interface CreatePaymentWithTokenParams {
  /** Idempotency: becomes the created payment's `id` (Moyasar `given_id`). Must be a fresh UUID per attempt. */
  givenId: string;
  /** Smallest currency unit (halalas for SAR) — use `toSmallestUnit`. */
  amount: number;
  currency: string;
  description?: string;
  callbackUrl: string;
  metadata?: Record<string, string>;
  token: string;
  cvc?: string;
  /** Authorize-only hold — always true for this integration (capture happens on admin accept). */
  manual: true;
  threeDs: boolean;
}

/** Thrown for a well-formed Moyasar API error response (4xx/5xx with a JSON body). */
export class MoyasarApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: unknown,
  ) {
    super(`Moyasar API error (HTTP ${httpStatus})`);
    this.name = 'MoyasarApiError';
  }
}

/** Thrown for network failure, timeout, or missing server configuration — always transient/operational, never the customer's fault. */
export class MoyasarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoyasarUnavailableError';
  }
}

/**
 * Backend-only Moyasar API client (Basic Auth with the secret key). Modeled
 * on GoogleRoutesService: AbortController timeout, single attempt (no
 * retry — callers decide whether a failure is safe to retry), typed error
 * mapping, secret read from ConfigService only, never logged.
 *
 * Deliberately has no method that accepts raw card fields (number/cvc as a
 * card, not a token) — this backend must never see a PAN, so the only
 * payment-creation entry point here takes a pre-existing Moyasar token.
 */
@Injectable()
export class MoyasarClientService {
  private readonly logger = new Logger(MoyasarClientService.name);

  constructor(private readonly config: ConfigService) {
    if (!this.config.get<string>('moyasar.secretKey')) {
      const message =
        'MOYASAR_SECRET_KEY is not configured — card payments (intent confirmation, capture, void, saved-card charges) will fail every request until it is set.';
      if (this.config.get<string>('nodeEnv') === 'production') {
        this.logger.error(`${message} This is unexpected in production.`);
      } else {
        this.logger.warn(message);
      }
    }
  }

  get isConfigured(): boolean {
    return Boolean(this.config.get<string>('moyasar.secretKey'));
  }

  async createPaymentWithToken(params: CreatePaymentWithTokenParams): Promise<MoyasarPayment> {
    return this.request<MoyasarPayment>('POST', '/payments', {
      given_id: params.givenId,
      amount: params.amount,
      currency: params.currency,
      description: params.description,
      callback_url: params.callbackUrl,
      metadata: params.metadata,
      source: {
        type: 'token',
        token: params.token,
        cvc: params.cvc,
        manual: params.manual,
        '3ds': params.threeDs,
      },
    });
  }

  async fetchPayment(paymentId: string): Promise<MoyasarPayment> {
    return this.request<MoyasarPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`);
  }

  /** No body = full capture. `amount` (smallest currency unit) for a partial capture, capped at the authorized amount. */
  async capturePayment(paymentId: string, amount?: number): Promise<MoyasarPayment> {
    return this.request<MoyasarPayment>(
      'POST',
      `/payments/${encodeURIComponent(paymentId)}/capture`,
      amount === undefined ? undefined : { amount },
    );
  }

  async voidPayment(paymentId: string): Promise<MoyasarPayment> {
    return this.request<MoyasarPayment>('POST', `/payments/${encodeURIComponent(paymentId)}/void`);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const secretKey = this.config.get<string>('moyasar.secretKey');
    if (!secretKey) {
      throw new MoyasarUnavailableError('Card payments are not configured on the server');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const auth = Buffer.from(`${secretKey}:`).toString('base64');

    let response: Response;
    try {
      response = await fetch(`${MOYASAR_API_BASE}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${auth}`,
        },
        // Never logs `body` — it may carry a token (not raw card data, but
        // still sensitive) and the Authorization header above.
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      this.logger.error(
        `Moyasar request to ${method} ${path} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      throw new MoyasarUnavailableError('Payment provider did not respond in time');
    } finally {
      clearTimeout(timer);
    }

    let json: unknown;
    try {
      json = response.status === 204 ? undefined : await response.json();
    } catch {
      this.logger.error(`Moyasar ${method} ${path} returned a malformed response body`);
      throw new MoyasarUnavailableError('Payment provider returned an unexpected response');
    }

    if (!response.ok) {
      this.logger.warn(`Moyasar ${method} ${path} returned HTTP ${response.status}`);
      throw new MoyasarApiError(response.status, json);
    }

    return json as T;
  }
}

/** SAR (and any other 2-decimal currency) major units -> smallest unit (halalas), as Moyasar's `amount` expects. */
export function toSmallestUnit(amount: Prisma.Decimal): number {
  return amount.times(100).round().toNumber();
}
