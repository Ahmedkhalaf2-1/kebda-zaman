import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * orderId/orderItemId/menuItemId/userId are never accepted here — only
 * rating/comment may change. Both are optional: an omitted field preserves
 * its existing value (see ReviewsService.updateItemReview, which only adds a
 * field to the Prisma update payload when it is present in the body); an
 * explicit `comment: null` (or a blank/whitespace-only string) clears the
 * comment. `@IsOptional()` also allows an explicit `null` for `comment` to
 * pass validation (it skips the string validators for null/undefined).
 */
export class UpdateItemReviewDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string | null;
}
