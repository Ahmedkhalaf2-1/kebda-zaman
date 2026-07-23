import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { CatalogService } from './catalog.service';
import { ListMenuItemsDto } from './dto/list-menu-items.dto';
import { SearchMenuDto } from './dto/search-menu.dto';

/**
 * Public, read-only catalog endpoints (plan §4.5-§4.7). No auth required.
 * Route order is unambiguous: /menu, /menu/search, and /menu/items/:id are
 * distinct literal segments, so there is no collision with the :id param.
 */
@Public()
@Controller({ version: '1' })
export class CatalogController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get('categories')
  listCategories() {
    return this.catalogService.listCategories();
  }

  @Get('categories/:id')
  getCategory(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalogService.getCategory(id);
  }

  @Get('menu')
  listMenuItems(@Query() query: ListMenuItemsDto) {
    return this.catalogService.listMenuItems(query);
  }

  @Get('menu/search')
  search(@Query() query: SearchMenuDto) {
    return this.catalogService.search(query);
  }

  @Get('menu/items/:id')
  getMenuItem(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalogService.getMenuItem(id);
  }

  @Get('home/featured')
  featured() {
    return this.catalogService.featured();
  }
}
