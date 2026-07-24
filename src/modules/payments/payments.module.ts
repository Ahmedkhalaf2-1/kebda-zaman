import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { PAYMENT_PROVIDERS, PaymentProvider } from './payment-provider.interface';
import { CashOnDeliveryProvider } from './providers/cash.provider';
import { UnconfiguredGatewayProvider } from './providers/unconfigured.provider';

@Module({
  controllers: [PaymentsController],
  providers: [
    CashOnDeliveryProvider,
    {
      provide: PAYMENT_PROVIDERS,
      useFactory: (cash: CashOnDeliveryProvider): PaymentProvider[] => [
        cash,
        new UnconfiguredGatewayProvider('CARD'),
        new UnconfiguredGatewayProvider('WALLET'),
      ],
      inject: [CashOnDeliveryProvider],
    },
    PaymentProviderRegistry,
    PaymentsService,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
