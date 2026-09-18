import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { ReverseGeocodeDto } from './dto/reverse-geocode.dto';
import { LocationsService, ReverseGeocodeResponseDto } from './locations.service';

@Roles('CUSTOMER')
@Controller({ path: 'locations', version: '1' })
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @HttpCode(HttpStatus.OK)
  @Post('reverse-geocode')
  reverseGeocode(@Body() dto: ReverseGeocodeDto): Promise<ReverseGeocodeResponseDto> {
    return this.locationsService.reverseGeocode(dto);
  }
}
