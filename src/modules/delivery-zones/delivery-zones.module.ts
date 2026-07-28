import { Module } from '@nestjs/common';
import { AdminDeliveryZonesController } from './admin-delivery-zones.controller';
import { DeliveryZonesController } from './delivery-zones.controller';
import { DeliveryZonesService } from './delivery-zones.service';

@Module({
  controllers: [AdminDeliveryZonesController, DeliveryZonesController],
  providers: [DeliveryZonesService],
  exports: [DeliveryZonesService],
})
export class DeliveryZonesModule {}
