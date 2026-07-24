import { Inject, Injectable, NotImplementedException } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { PAYMENT_PROVIDERS, PaymentProvider } from './payment-provider.interface';

/**
 * Looks providers up by PaymentMethod (checkout/intent) or by name
 * (webhook routing). Adding a real gateway later = register one more
 * PaymentProvider in payments.module.ts — nothing here changes.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly byMethod = new Map<PaymentMethod, PaymentProvider>();
  private readonly byName = new Map<string, PaymentProvider>();

  constructor(@Inject(PAYMENT_PROVIDERS) providers: PaymentProvider[]) {
    for (const provider of providers) {
      this.byName.set(provider.name, provider);
      for (const method of provider.methods) {
        this.byMethod.set(method, provider);
      }
    }
  }

  getByMethod(method: PaymentMethod): PaymentProvider {
    const provider = this.byMethod.get(method);
    if (!provider) {
      throw new NotImplementedException({
        message: `No payment provider registered for ${method}`,
        code: 'PAYMENT_PROVIDER_NOT_CONFIGURED',
      });
    }
    return provider;
  }

  getByName(name: string): PaymentProvider | undefined {
    return this.byName.get(name);
  }
}
