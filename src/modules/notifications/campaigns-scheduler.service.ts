import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { CampaignsService } from './campaigns.service';

const POLL_INTERVAL_MS = 60_000;

/**
 * Simplest reliable scheduler (plan §9.5): no Redis. Polls Postgres every 60s
 * for due SCHEDULED campaigns; state lives in the DB, so this is durable
 * across restarts. Double-send is prevented by an atomic guarded
 * SCHEDULED->SENDING transition (`updateMany` with a status filter) — if two
 * ticks (or instances) race for the same row, only one `updateMany` matches.
 */
@Injectable()
export class CampaignsSchedulerService {
  private readonly logger = new Logger(CampaignsSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly campaignsService: CampaignsService,
  ) {}

  @Interval(POLL_INTERVAL_MS)
  async processScheduledCampaigns(): Promise<void> {
    const due = await this.prisma.notificationCampaign.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
      select: { id: true },
    });
    for (const { id } of due) {
      await this.claimAndDispatch(id);
    }
  }

  /** Public so tests can trigger a tick deterministically instead of waiting on the real interval. */
  async claimAndDispatch(id: string): Promise<void> {
    const claimed = await this.prisma.notificationCampaign.updateMany({
      where: { id, status: 'SCHEDULED' },
      data: { status: 'SENDING' },
    });
    if (claimed.count !== 1) {
      return; // Already claimed by another tick/instance — no double-send.
    }

    try {
      const campaign = await this.prisma.notificationCampaign.findUniqueOrThrow({ where: { id } });
      await this.campaignsService.dispatch(campaign);
    } catch (error) {
      this.logger.error(`Failed to dispatch scheduled campaign ${id}: ${(error as Error).message}`);
    }
  }
}
