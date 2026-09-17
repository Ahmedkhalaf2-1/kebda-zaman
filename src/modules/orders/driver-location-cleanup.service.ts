import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';

const POLL_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes

/** Grace window before physically deleting a no-longer-trackable order's
 * location row. Purely a safety margin against racing a write that just
 * landed milliseconds ago — logical access is already blocked instantly
 * regardless of this delay (see OrderTrackingResponseDto's state
 * derivation); this constant only bounds on-disk storage. */
const CLEANUP_GRACE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Storage hygiene only (Phase 2 live tracking) — NOT a security boundary.
 * DriverLocationService's read path already makes a location row instantly
 * inaccessible the moment its order leaves OUT_FOR_DELIVERY, is unassigned,
 * or moves to a new assignment version — this job only reclaims the
 * now-orphaned row afterwards. Same no-Redis, DB-durable polling pattern as
 * CampaignsSchedulerService (state lives in Postgres, so a restart between
 * ticks loses nothing).
 */
@Injectable()
export class DriverLocationCleanupService {
  private readonly logger = new Logger(DriverLocationCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Interval(POLL_INTERVAL_MS)
  async cleanupStaleLocationsTick(): Promise<void> {
    try {
      await this.run();
    } catch (error) {
      this.logger.error(`Driver-location cleanup failed: ${(error as Error).message}`);
    }
  }

  /** Public so tests can trigger a cleanup pass deterministically instead of
   * waiting on the real interval. Returns the number of rows removed. */
  async run(): Promise<number> {
    const cutoff = new Date(Date.now() - CLEANUP_GRACE_MS);
    const deleted = await this.prisma.orderDriverLocation.deleteMany({
      where: {
        updatedAt: { lte: cutoff },
        order: { OR: [{ status: { not: 'OUT_FOR_DELIVERY' } }, { driverId: null }] },
      },
    });
    if (deleted.count > 0) {
      this.logger.log(`Cleaned up ${deleted.count} stale driver-location row(s).`);
    }
    return deleted.count;
  }
}
