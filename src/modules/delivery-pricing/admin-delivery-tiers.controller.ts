import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  toDeliveryDistanceTierResponse,
  DeliveryDistanceTierResponseDto,
} from '../../common/mappers/delivery-distance-tier-response.mapper';
import { DeliveryPricingService } from './delivery-pricing.service';
import { DeliveryDistanceTierDto } from './dto/delivery-distance-tier.dto';

@Roles('ADMIN')
@Controller({ path: 'admin/delivery-tiers', version: '1' })
export class AdminDeliveryTiersController {
  constructor(private readonly deliveryPricingService: DeliveryPricingService) {}

  @Get()
  async list(): Promise<DeliveryDistanceTierResponseDto[]> {
    const tiers = await this.deliveryPricingService.adminList();
    return tiers.map(toDeliveryDistanceTierResponse);
  }

  @Post()
  async create(@Body() dto: DeliveryDistanceTierDto): Promise<DeliveryDistanceTierResponseDto> {
    const tier = await this.deliveryPricingService.create(dto);
    return toDeliveryDistanceTierResponse(tier);
  }

  /** Full-replace update — also covers activate/deactivate (isActive) and
   * reordering (sortOrder), same convention as the retired AdminDeliveryZonesController. */
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliveryDistanceTierDto,
  ): Promise<DeliveryDistanceTierResponseDto> {
    const tier = await this.deliveryPricingService.update(id, dto);
    return toDeliveryDistanceTierResponse(tier);
  }
}
