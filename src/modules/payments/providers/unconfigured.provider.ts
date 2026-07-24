import { NotImplementedException } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import {
  ParsedWebhookEvent,
  PaymentIntentResult,
  PaymentProvider,
  WebhookVerificationResult,
} from '../payment-provider.interface';

/**
 * Placeholder for CARD/WALLET until a real gateway (Moyasar/PayTabs/...) is
 * selected and wired up. Never fakes a successful payment — every entry
 * point fails loudly with a clear "not configured" signal.
 */
export class UnconfiguredGatewayProvider implements PaymentProvider {
  readonly isConfigured = false;
  readonly methods: PaymentMethod[];

  constructor(private readonly method: PaymentMethod) {
    this.methods = [method];
  }

  get name(): string {
    return `${this.method.toLowerCase()}_gateway`;
  }

  async createIntent(): Promise<PaymentIntentResult> {
    throw new NotImplementedException({
      message: `${this.method} payments are not available yet — no payment gateway is configured`,
      code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
    });
  }

  verifyWebhook(): WebhookVerificationResult {
    return { valid: false, reason: 'No payment gateway is configured for this method' };
  }

  parseWebhook(): ParsedWebhookEvent {
    throw new NotImplementedException({
      message: `${this.method} payments are not available yet — no payment gateway is configured`,
      code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
    });
  }
}
