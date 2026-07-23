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
  Put,
  Query,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { CatalogService } from './catalog.service';
import { MenuItemDto } from './dto/menu-item.dto';
import { AdminListMenuItemsDto } from './dto/admin-list-menu-items.dto';
import { SetAvailabilityDto } from './dto/set-availability.dto';

@Roles('ADMIN')
@Controller({ path: 'admin/menu', version: '1' })
export class AdminMenuController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  list(@Query() query: AdminListMenuItemsDto) {
    return this.catalogService.adminListMenuItems(query);
  }

  @Post('items')
  create(@Body() dto: MenuItemDto) {
    return this.catalogService.createMenuItem(dto);
  }

  @Put('items/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MenuItemDto) {
    return this.catalogService.updateMenuItem(id, dto);
  }

  @Patch('items/:id/availability')
  setAvailability(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetAvailabilityDto) {
    return this.catalogService.setMenuItemAvailability(id, dto.isAvailable);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('items/:id')
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.catalogService.deleteMenuItem(id);
  }
}
