import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { ReviewsService } from './reviews.service';
import { AdminListItemReviewsDto } from './dto/admin-list-item-reviews.dto';
import { AdminListOrderFeedbackDto } from './dto/admin-list-order-feedback.dto';

/** Internal operational APIs — customer identity is safe to expose here (unlike the customer-facing controller). */
@Roles('ADMIN')
@Controller({ path: 'admin/reviews', version: '1' })
export class AdminReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Get('items')
  listItemReviews(@Query() query: AdminListItemReviewsDto) {
    return this.reviewsService.adminListItemReviews(query);
  }

  @Get('orders')
  listOrderFeedback(@Query() query: AdminListOrderFeedbackDto) {
    return this.reviewsService.adminListOrderFeedback(query);
  }

  @Get('summary')
  summary() {
    return this.reviewsService.adminSummary();
  }
}
