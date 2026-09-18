import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { ReviewsService, assertNotGuest } from './reviews.service';
import { CreateItemReviewDto } from './dto/create-item-review.dto';
import { UpdateItemReviewDto } from './dto/update-item-review.dto';
import { CreateOrderFeedbackDto } from './dto/create-order-feedback.dto';
import { UpdateOrderFeedbackDto } from './dto/update-order-feedback.dto';

/** `role=CUSTOMER` alone doesn't exclude guests (guests are role=CUSTOMER, isGuest=true) — checked explicitly, same convention as `me/loyalty`. */
@Roles('CUSTOMER')
@Controller({ path: 'reviews', version: '1' })
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Post('items')
  createItemReview(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateItemReviewDto) {
    assertNotGuest(user.isGuest);
    return this.reviewsService.createItemReview(user.id, dto);
  }

  @Patch('items/:reviewId')
  updateItemReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() dto: UpdateItemReviewDto,
  ) {
    assertNotGuest(user.isGuest);
    return this.reviewsService.updateItemReview(user.id, reviewId, dto);
  }

  @Get('me/orders/:orderId')
  getOrderReviewEligibility(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    assertNotGuest(user.isGuest);
    return this.reviewsService.getOrderReviewEligibility(user.id, orderId);
  }

  @Post('orders')
  createOrderFeedback(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrderFeedbackDto) {
    assertNotGuest(user.isGuest);
    return this.reviewsService.createOrderFeedback(user.id, dto);
  }

  @Patch('orders/:feedbackId')
  updateOrderFeedback(
    @CurrentUser() user: AuthenticatedUser,
    @Param('feedbackId', ParseUUIDPipe) feedbackId: string,
    @Body() dto: UpdateOrderFeedbackDto,
  ) {
    assertNotGuest(user.isGuest);
    return this.reviewsService.updateOrderFeedback(user.id, feedbackId, dto);
  }
}
