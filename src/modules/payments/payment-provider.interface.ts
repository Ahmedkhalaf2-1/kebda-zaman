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

/** Result of a capture/void/confirm/token-charge call — deliberately slim: gateway specifics stay inside the provider. */
export interface PaymentGatewayResult {
  providerRef: string;
  status: PaymentStatus;
  /** Present only when the gateway requires further customer action (e.g. a 3DS challenge) before the status above is final. */
  transactionUrl?: string;
  /** Present only when the payment was made/saved with a tokenizable card the caller should persist as a SavedCard. */
  savedCard?: {
    token: string;
    brand: string;
    lastFour: string;
    expMonth: number;
    expYear: number;
    status: string;
  };
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

  /**
   * Optional gateway-specific operations — only implemented by providers
   * that support an authorize+capture/void flow (Moyasar). Orders/Payments
   * call these without knowing which gateway is behind them; a provider
   * that has nothing to capture/void/confirm (e.g. cash) simply omits them.
   */
  /** Server-side verification of a client-reported payment result — never trusts the client's claimed status. */
  confirm?(
    order: Order,
    payment: Payment,
    providerPaymentId: string,
  ): Promise<PaymentGatewayResult>;
  capture?(order: Order, payment: Payment): Promise<PaymentGatewayResult>;
  void?(order: Order, payment: Payment): Promise<PaymentGatewayResult>;
  chargeWithSavedCard?(
    order: Order,
    payment: Payment,
    savedCard: { token: string },
    cvc: string | undefined,
  ): Promise<PaymentGatewayResult>;
}

/** DI token for the array of registered providers (see payments.module.ts). */
export const PAYMENT_PROVIDERS = Symbol('PAYMENT_PROVIDERS');
