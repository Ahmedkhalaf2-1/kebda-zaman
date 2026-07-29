import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CampaignTargetAudience, NotificationCampaign, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from './notifications.service';
import { AppNotificationPayload, NotificationType } from './notification-payload';
import { CampaignDto, ListCampaignsDto, ScheduleCampaignDto } from './dto/campaign.dto';

const CAMPAIGNS_PAGE_SIZE = 20;

export interface AdminCampaignResponseDto {
  id: string;
  campaignName: string;
  title: string;
  body: string;
  imageUrl: string | null;
  type: string;
  targetAudience: CampaignTargetAudience;
  destinationRoute: string | null;
  entityId: string | null;
  status: string;
  isScheduled: boolean;
  scheduledAt: string | null;
  sentAt: string | null;
  totalRecipients: number;
  deliveredCount: number;
  openedCount: number;
  clickRate: number;
  createdAt: string;
}

function toAdminCampaignResponse(campaign: NotificationCampaign): AdminCampaignResponseDto {
  return {
    id: campaign.id,
    campaignName: campaign.campaignName,
    title: campaign.title,
    body: campaign.body,
    imageUrl: campaign.imageUrl,
    type: campaign.type,
    targetAudience: campaign.targetAudience,
    destinationRoute: campaign.destinationRoute,
    entityId: campaign.entityId,
    status: campaign.status,
    isScheduled: campaign.isScheduled,
    scheduledAt: campaign.scheduledAt?.toISOString() ?? null,
    sentAt: campaign.sentAt?.toISOString() ?? null,
    totalRecipients: campaign.totalRecipients,
    deliveredCount: campaign.deliveredCount,
    openedCount: campaign.openedCount,
    clickRate: campaign.clickRate.toNumber(),
    createdAt: campaign.createdAt.toISOString(),
  };
}

/**
 * Admin campaign flow (plan §9.4/§9.5): Admin Panel -> persist campaign ->
 * resolve target audience -> Firebase Admin SDK (via Phase 6
 * NotificationsService) -> FCM -> devices. The scheduler
 * (CampaignsSchedulerService) reuses `dispatch` for SCHEDULED campaigns.
 */
@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async listCampaigns(query: ListCampaignsDto): Promise<AdminCampaignResponseDto[]> {
    const page = query.page ?? 1;
    const campaigns = await this.prisma.notificationCampaign.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * CAMPAIGNS_PAGE_SIZE,
      take: CAMPAIGNS_PAGE_SIZE,
    });
    return campaigns.map(toAdminCampaignResponse);
  }

  /** Persists the campaign as SENDING, dispatches immediately, and settles to SENT/FAILED. */
  async send(adminUserId: string, dto: CampaignDto): Promise<AdminCampaignResponseDto> {
    const campaign = await this.prisma.notificationCampaign.create({
      data: {
        ...this.baseCampaignData(dto),
        status: 'SENDING',
        isScheduled: false,
        createdByUserId: adminUserId,
      },
    });
    const dispatched = await this.dispatch(campaign);
    return toAdminCampaignResponse(dispatched);
  }

  /** Persists the campaign as SCHEDULED; CampaignsSchedulerService picks it up later. */
  async schedule(adminUserId: string, dto: ScheduleCampaignDto): Promise<AdminCampaignResponseDto> {
    const campaign = await this.prisma.notificationCampaign.create({
      data: {
        ...this.baseCampaignData(dto),
        status: 'SCHEDULED',
        isScheduled: true,
        scheduledAt: new Date(dto.scheduledAt),
        createdByUserId: adminUserId,
      },
    });
    return toAdminCampaignResponse(campaign);
  }

  /** Only DRAFT/SCHEDULED campaigns may be removed (plan §4.22) — a sent/sending/failed one is history. */
  async remove(id: string): Promise<void> {
    const existing = await this.prisma.notificationCampaign.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({ message: 'Campaign not found', code: 'CAMPAIGN_NOT_FOUND' });
    }
    if (existing.status !== 'DRAFT' && existing.status !== 'SCHEDULED') {
      throw new ConflictException({
        message: 'Only draft or scheduled campaigns can be deleted',
        code: 'CAMPAIGN_NOT_DELETABLE',
      });
    }
    await this.prisma.notificationCampaign.delete({ where: { id } });
  }

  /**
   * Dispatches an already-persisted campaign (status already SENDING).
   * Never throws — a send failure is caught and persisted as FAILED so a
   * flaky FCM call can never crash the request or the scheduler tick.
   */
  async dispatch(campaign: NotificationCampaign): Promise<NotificationCampaign> {
    // Declared outside the try so the catch block can still report how many
    // recipients were resolved before a later step (e.g. the FCM call
    // itself) threw.
    let tokens: string[] = [];
    try {
      tokens = await this.resolveAudienceTokens(campaign.targetAudience);
      const payload: AppNotificationPayload = {
        id: campaign.id,
        type: campaign.type as NotificationType,
        title: campaign.title,
        body: campaign.body,
        route: campaign.destinationRoute ?? undefined,
        entityId: campaign.entityId ?? undefined,
        imageUrl: campaign.imageUrl ?? undefined,
        timestamp: Date.now().toString(),
      };
      const result = await this.notificationsService.sendToTokens(tokens, payload);

      // A campaign with resolved recipients but zero successful deliveries must
      // never be recorded as SENT — that would silently mask e.g. Firebase
      // being unconfigured/disabled in production, or a total FCM outage,
      // behind a false "success" status. (0 recipients still counts as SENT:
      // there was nothing to fail.)
      const fullyFailed = tokens.length > 0 && result.successCount === 0 && result.failureCount > 0;
      if (fullyFailed) {
        this.logger.warn(
          `Campaign ${campaign.id} resolved ${tokens.length} recipient(s) but delivered to none ` +
            `(Firebase unconfigured or FCM rejected every send) — recording as FAILED, not SENT.`,
        );
      } else if (result.successCount > 0 && result.failureCount > 0) {
        // Partial delivery. The CampaignStatus enum has no PARTIALLY_SENT
        // value, so this is recorded as SENT (some devices did receive it)
        // with deliveredCount below totalRecipients reflecting the shortfall
        // honestly — it is never rounded up to "everyone got it".
        this.logger.warn(
          `Campaign ${campaign.id} partially delivered: ${result.successCount}/${tokens.length} ` +
            `succeeded, ${result.failureCount} failed.`,
        );
      }

      return await this.prisma.notificationCampaign.update({
        where: { id: campaign.id },
        data: {
          status: fullyFailed ? 'FAILED' : 'SENT',
          sentAt: fullyFailed ? null : new Date(),
          totalRecipients: tokens.length,
          deliveredCount: result.successCount,
        },
      });
    } catch (error) {
      // Log only the error message — never the resolved tokens or any
      // Firebase credential material.
      this.logger.error(`Campaign ${campaign.id} failed to send: ${(error as Error).message}`);
      return this.prisma.notificationCampaign.update({
        where: { id: campaign.id },
        data: {
          status: 'FAILED',
          sentAt: null,
          totalRecipients: tokens.length,
          deliveredCount: 0,
        },
      });
    }
  }

  /** ALL/CUSTOMERS/GUESTS resolved from DeviceToken + the owning User.isGuest — no new data needed. */
  private async resolveAudienceTokens(targetAudience: CampaignTargetAudience): Promise<string[]> {
    const where: Prisma.DeviceTokenWhereInput = { isActive: true };
    if (targetAudience === 'CUSTOMERS') {
      where.user = { isGuest: false };
    } else if (targetAudience === 'GUESTS') {
      where.OR = [{ userId: null }, { user: { isGuest: true } }];
    }
    const tokens = await this.prisma.deviceToken.findMany({ where, select: { token: true } });
    return tokens.map((device) => device.token);
  }

  private baseCampaignData(dto: CampaignDto) {
    return {
      campaignName: dto.campaignName,
      title: dto.title,
      body: dto.body,
      imageUrl: dto.imageUrl,
      type: dto.type,
      targetAudience: dto.targetAudience ?? CampaignTargetAudience.ALL,
      destinationRoute: dto.destinationRoute,
      entityId: dto.entityId,
    };
  }
}
