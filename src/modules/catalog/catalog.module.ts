import { Module } from '@nestjs/common';
import { ReviewsModule } from '../reviews/reviews.module';
import { CatalogController } from './catalog.controller';
import { AdminCategoriesController } from './admin-categories.controller';
import { AdminMenuController } from './admin-menu.controller';
import { CatalogService } from './catalog.service';

@Module({
  imports: [ReviewsModule],
  controllers: [CatalogController, AdminCategoriesController, AdminMenuController],
  providers: [CatalogService],
})
export class CatalogModule {}
