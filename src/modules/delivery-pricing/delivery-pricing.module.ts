import { Module } from '@nestjs/common';
import { AdminDeliveryTiersController } from './admin-delivery-tiers.controller';
import { DeliveryQuoteController } from './delivery-quote.controller';
import { DeliveryPricingService } from './delivery-pricing.service';
import { GoogleRoutesService } from './google-routes.service';

@Module({
  controllers: [AdminDeliveryTiersController, DeliveryQuoteController],
  providers: [DeliveryPricingService, GoogleRoutesService],
  exports: [DeliveryPricingService],
})
export class DeliveryPricingModule {}
