import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { AdminCategoriesController } from './admin-categories.controller';
import { AdminMenuController } from './admin-menu.controller';
import { CatalogService } from './catalog.service';

@Module({
  controllers: [CatalogController, AdminCategoriesController, AdminMenuController],
  providers: [CatalogService],
})
export class CatalogModule {}
