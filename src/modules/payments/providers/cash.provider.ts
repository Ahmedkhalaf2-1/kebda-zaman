import { Injectable } from '@nestjs/common';
import { Order, Payment, PaymentMethod } from '@prisma/client';
import {
  ParsedWebhookEvent,
  PaymentIntentResult,
  PaymentProvider,
  WebhookVerificationResult,
} from '../payment-provider.interface';

/**
 * Cash-on-delivery: no external gateway round-trip. The Payment created at
 * checkout stays PENDING; it is settled to PAID when the order is delivered
 * (see OrdersService.updateOrderStatus), never via a webhook.
 */
@Injectable()
export class CashOnDeliveryProvider implements PaymentProvider {
  readonly name = 'cod';
  readonly methods: PaymentMethod[] = ['CASH'];
  readonly isConfigured = true;

  async createIntent(_order: Order, payment: Payment): Promise<PaymentIntentResult> {
    return {
      providerRef: null,
      status: payment.status,
      clientData: { instructions: 'Pay with cash upon delivery' },
    };
  }

  verifyWebhook(): WebhookVerificationResult {
    return { valid: false, reason: 'Cash on delivery does not receive webhooks' };
  }

  parseWebhook(): ParsedWebhookEvent {
    throw new Error('Cash on delivery does not receive webhooks');
  }
}
