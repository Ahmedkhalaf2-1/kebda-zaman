import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { MenuOffersService } from './menu-offers.service';
import { MenuOfferDto } from './dto/menu-offer.dto';

@Roles('ADMIN')
@Controller({ path: 'admin/menu-offers', version: '1' })
export class AdminMenuOffersController {
  constructor(private readonly menuOffersService: MenuOffersService) {}

  @Get()
  list() {
    return this.menuOffersService.adminList();
  }

  @Post()
  create(@Body() dto: MenuOfferDto) {
    return this.menuOffersService.create(dto);
  }

  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MenuOfferDto) {
    return this.menuOffersService.update(id, dto);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.menuOffersService.remove(id);
  }
}
