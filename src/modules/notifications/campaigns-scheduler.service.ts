import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { CampaignsService } from './campaigns.service';

const POLL_INTERVAL_MS = 60_000;

/**
 * A SCHEDULED->SENDING claim with no SENT/FAILED settlement after this long
 * is treated as abandoned (process/container crash between the claim and
 * `CampaignsService.dispatch()` persisting its result) and recovered as
 * FAILED — see `recoverStaleSendingCampaigns`.
 */
const STALE_SENDING_TIMEOUT_MS = 10 * 60 * 1000;

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
    try {
      await this.recoverStaleSendingCampaigns();
    } catch (error) {
      this.logger.error(`Stale scheduled-campaign recovery failed: ${(error as Error).message}`);
    }

    let due: Array<{ id: string }>;
    try {
      due = await this.prisma.notificationCampaign.findMany({
        where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
        select: { id: true },
      });
    } catch (error) {
      this.logger.error(`Failed to query due scheduled campaigns: ${(error as Error).message}`);
      return;
    }

    // Sequential on purpose (no Promise.all): one campaign's DB/dispatch
    // failure must not stop the rest of the tick, but campaigns still go out
    // one at a time to avoid an uncontrolled notification burst.
    for (const { id } of due) {
      try {
        await this.claimAndDispatch(id);
      } catch (error) {
        this.logger.error(`Scheduler tick failed for campaign ${id}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Recovers SCHEDULED campaigns abandoned mid-send: claimed (SENDING) more
   * than STALE_SENDING_TIMEOUT_MS ago and never settled to SENT/FAILED
   * (`sentAt` still null). Recovered as FAILED, never re-queued to SCHEDULED
   * or resent automatically — the crashed process may already have
   * delivered some or all notifications, so an automatic retry could
   * duplicate them. `totalRecipients` is left untouched (it may already hold
   * useful progress information); `deliveredCount` is reset to 0 since a
   * FAILED campaign must not claim partial delivery it can no longer verify.
   */
  private async recoverStaleSendingCampaigns(): Promise<void> {
    const staleCutoff = new Date(Date.now() - STALE_SENDING_TIMEOUT_MS);
    const recovered = await this.prisma.notificationCampaign.updateMany({
      where: {
        status: 'SENDING',
        isScheduled: true,
        sentAt: null,
        updatedAt: { lte: staleCutoff },
      },
      data: {
        status: 'FAILED',
        sentAt: null,
        deliveredCount: 0,
      },
    });

    if (recovered.count > 0) {
      this.logger.warn(
        `Recovered ${recovered.count} stale scheduled campaign claim(s) as FAILED after ` +
          `${STALE_SENDING_TIMEOUT_MS}ms timeout.`,
      );
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
