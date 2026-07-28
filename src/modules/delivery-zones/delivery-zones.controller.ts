import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { DeliveryZonesService } from './delivery-zones.service';

@Public()
@Controller({ path: 'delivery-zones', version: '1' })
export class DeliveryZonesController {
  constructor(private readonly deliveryZonesService: DeliveryZonesService) {}

  @Get()
  listActive() {
    return this.deliveryZonesService.listActive();
  }
}
