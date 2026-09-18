import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { PAYMENT_PROVIDERS, PaymentProvider } from './payment-provider.interface';
import { CashOnDeliveryProvider } from './providers/cash.provider';
import { UnconfiguredGatewayProvider } from './providers/unconfigured.provider';
import { MoyasarProvider } from './providers/moyasar.provider';
import { MoyasarClientService } from './moyasar/moyasar-client.service';

@Module({
  controllers: [PaymentsController],
  providers: [
    CashOnDeliveryProvider,
    MoyasarClientService,
    MoyasarProvider,
    {
      provide: PAYMENT_PROVIDERS,
      useFactory: (cash: CashOnDeliveryProvider, moyasar: MoyasarProvider): PaymentProvider[] => [
        cash,
        moyasar,
        new UnconfiguredGatewayProvider('WALLET'),
      ],
      inject: [CashOnDeliveryProvider, MoyasarProvider],
    },
    PaymentProviderRegistry,
    PaymentsService,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
