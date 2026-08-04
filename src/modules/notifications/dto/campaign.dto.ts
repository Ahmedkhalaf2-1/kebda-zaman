import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Min,
  MaxLength,
} from 'class-validator';
import { CampaignTargetAudience } from '@prisma/client';
import { NOTIFICATION_TYPES, NotificationType } from '../notification-payload';

/**
 * destinationRoute must be an internal, relative app path (matches the shape
 * every route this backend generates already uses, e.g.
 * `/orders/tracking/:id`, `/promos`) — never a scheme (`http:`, `https:`,
 * `javascript:`, `intent:`, ...), which would let a stored deep link open an
 * arbitrary external URL or trigger a scheme handler on the client (§4).
 */
const INTERNAL_ROUTE_PATTERN = /^\/[a-zA-Z0-9\-_/]*$/;

/** plan §4.22: shared shape for immediate send and schedule. */
export class CampaignDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  campaignName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  body!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  imageUrl?: string;

  // Matches the AppNotificationPayload NotificationType contract exactly (plan §9.4).
  @IsIn(NOTIFICATION_TYPES)
  type!: NotificationType;

  // ALL/CUSTOMERS/GUESTS — plan §2.18/§9.5 ("start with ALL"); defaults to ALL when omitted.
  @IsOptional()
  @IsEnum(CampaignTargetAudience)
  targetAudience?: CampaignTargetAudience;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(INTERNAL_ROUTE_PATTERN, {
    message:
      'destinationRoute must be an internal app path starting with "/" (no schemes/protocols)',
  })
  destinationRoute?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  entityId?: string;
}

export class ScheduleCampaignDto extends CampaignDto {
  @IsDateString()
  scheduledAt!: string;
}

export class ListCampaignsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;
}
