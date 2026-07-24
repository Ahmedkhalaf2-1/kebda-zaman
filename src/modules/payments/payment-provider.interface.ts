import { Order, Payment, PaymentMethod, PaymentStatus } from '@prisma/client';

/**
 * Gateway-agnostic provider contract (plan §10.1). Implement one adapter per
 * real gateway (Moyasar, PayTabs, ...) later — Orders/Payments never see
 * gateway specifics, only this interface.
 */
export interface PaymentIntentResult {
  /** Gateway transaction id. Null when the method needs no external round-trip (e.g. cash). */
  providerRef: string | null;
  status: PaymentStatus;
  /** Redirect URL / iframe token / client secret — whatever the frontend needs to complete payment. */
  clientData?: Record<string, unknown>;
}

export interface WebhookVerificationResult {
  valid: boolean;
  reason?: string;
}

export interface ParsedWebhookEvent {
  providerRef: string;
  status: PaymentStatus;
  amount?: string;
}

export interface PaymentProvider {
  /** Routing key for webhook dispatch (`?provider=<name>`) — distinct from PaymentMethod. */
  readonly name: string;
  /** The PaymentMethod value(s) this provider handles for intent creation. */
  readonly methods: PaymentMethod[];
  /** False for placeholder adapters with no real gateway wired up yet. */
  readonly isConfigured: boolean;

  createIntent(order: Order, payment: Payment): Promise<PaymentIntentResult>;
  verifyWebhook(headers: Record<string, string>, rawBody: string): WebhookVerificationResult;
  parseWebhook(rawBody: string): ParsedWebhookEvent;
}

/** DI token for the array of registered providers (see payments.module.ts). */
export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');
