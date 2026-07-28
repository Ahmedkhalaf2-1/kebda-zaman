import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { DeliveryZonesService } from './delivery-zones.service';
import { DeliveryZoneDto } from './dto/delivery-zone.dto';

@Roles('ADMIN')
@Controller({ path: 'admin/delivery-zones', version: '1' })
export class AdminDeliveryZonesController {
  constructor(private readonly deliveryZonesService: DeliveryZonesService) {}

  @Get()
  list() {
    return this.deliveryZonesService.adminList();
  }

  @Post()
  create(@Body() dto: DeliveryZoneDto) {
    return this.deliveryZonesService.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeliveryZoneDto) {
    return this.deliveryZonesService.update(id, dto);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.deliveryZonesService.remove(id);
  }
}
