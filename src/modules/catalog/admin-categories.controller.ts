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
import { CatalogService } from './catalog.service';
import { CategoryDto } from './dto/category.dto';

@Roles('ADMIN')
@Controller({ path: 'admin/categories', version: '1' })
export class AdminCategoriesController {
  constructor(private readonly catalogService: CatalogService) {}

  @Get()
  list() {
    return this.catalogService.adminListCategories();
  }

  @Post()
  create(@Body() dto: CategoryDto) {
    return this.catalogService.createCategory(dto);
  }

  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CategoryDto) {
    return this.catalogService.updateCategory(id, dto);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.catalogService.deleteCategory(id);
  }
}
