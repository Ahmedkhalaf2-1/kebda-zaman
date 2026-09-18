import { Logger } from '@nestjs/common';
import { CampaignsSchedulerService } from './campaigns-scheduler.service';
import { CampaignsService } from './campaigns.service';
import { PrismaService } from '../../prisma/prisma.service';

const STALE_SENDING_TIMEOUT_MS = 10 * 60 * 1000;
const NOW = new Date('2026-01-01T00:00:00.000Z');

interface FakeCampaign {
  id: string;
  status: 'DRAFT' | 'SCHEDULED' | 'SENDING' | 'SENT' | 'FAILED';
  isScheduled: boolean;
  sentAt: Date | null;
  updatedAt: Date;
  totalRecipients: number;
  deliveredCount: number;
}

function makeCampaign(overrides: Partial<FakeCampaign> & { id: string }): FakeCampaign {
  return {
    status: 'SCHEDULED',
    isScheduled: true,
    sentAt: null,
    updatedAt: NOW,
    totalRecipients: 0,
    deliveredCount: 0,
    ...overrides,
  };
}

/**
 * Filters `campaigns` the way Postgres/Prisma would for the `where` clauses
 * this scheduler issues (recovery: status/isScheduled/sentAt/updatedAt;
 * claim: id/status), applies `data`, and returns the Prisma `{ count }`
 * shape — giving the unit tests real filtering behavior instead of only
 * asserting query shape.
 */
function fakeUpdateMany(campaigns: FakeCampaign[]) {
  return jest.fn(async ({ where, data }: any) => {
    let count = 0;
    for (const c of campaigns) {
      if (where.id !== undefined && c.id !== where.id) continue;
      if (where.status !== undefined && c.status !== where.status) continue;
      if (where.isScheduled !== undefined && c.isScheduled !== where.isScheduled) continue;
      if (where.sentAt === null && c.sentAt !== null) continue;
      if (where.updatedAt?.lte && !(c.updatedAt.getTime() <= where.updatedAt.lte.getTime())) {
        continue;
      }
      Object.assign(c, data);
      count++;
    }
    return { count };
  });
}

describe('CampaignsSchedulerService', () => {
  let prisma: {
    notificationCampaign: {
      updateMany: jest.Mock;
      findMany: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
  };
  let campaignsService: { dispatch: jest.Mock };
  let scheduler: CampaignsSchedulerService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    prisma = {
      notificationCampaign: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
        findUniqueOrThrow: jest.fn(),
      },
    };
    campaignsService = { dispatch: jest.fn() };
    scheduler = new CampaignsSchedulerService(
      prisma as unknown as PrismaService,
      campaignsService as unknown as CampaignsService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('stale SENDING recovery', () => {
    it('recovers a stale scheduled SENDING campaign to FAILED, clears sentAt/deliveredCount, ' +
      'and preserves totalRecipients', async () => {
      const stale = makeCampaign({
        id: 'stale-1',
        status: 'SENDING',
        isScheduled: true,
        sentAt: null,
        updatedAt: new Date(NOW.getTime() - STALE_SENDING_TIMEOUT_MS - 1),
        totalRecipients: 42,
        deliveredCount: 7,
      });
      prisma.notificationCampaign.updateMany = fakeUpdateMany([stale]);

      await scheduler.processScheduledCampaigns();

      expect(stale.status).toBe('FAILED');
      expect(stale.sentAt).toBeNull();
      expect(stale.deliveredCount).toBe(0);
      expect(stale.totalRecipients).toBe(42); // untouched — not reset to 0

      const recoveryCall = prisma.notificationCampaign.updateMany.mock.calls[0][0];
      expect(recoveryCall.where).toMatchObject({
        status: 'SENDING',
        isScheduled: true,
        sentAt: null,
      });
      expect(recoveryCall.where.updatedAt.lte).toEqual(new Date(NOW.getTime() - STALE_SENDING_TIMEOUT_MS));
      expect(recoveryCall.data).toEqual({ status: 'FAILED', sentAt: null, deliveredCount: 0 });
    });

    it('does not recover a fresh SENDING campaign (updatedAt within the cutoff)', async () => {
      const fresh = makeCampaign({
        id: 'fresh-1',
        status: 'SENDING',
        isScheduled: true,
        sentAt: null,
        updatedAt: new Date(NOW.getTime() - STALE_SENDING_TIMEOUT_MS + 1000), // 1s inside the window
      });
      prisma.notificationCampaign.updateMany = fakeUpdateMany([fresh]);

      await scheduler.processScheduledCampaigns();

      expect(fresh.status).toBe('SENDING'); // unchanged
    });

    it('does not recover a SENDING campaign that is not scheduled (isScheduled: false)', async () => {
      const immediateSend = makeCampaign({
        id: 'immediate-1',
        status: 'SENDING',
        isScheduled: false,
        sentAt: null,
        updatedAt: new Date(NOW.getTime() - STALE_SENDING_TIMEOUT_MS - 1),
      });
      prisma.notificationCampaign.updateMany = fakeUpdateMany([immediateSend]);

      await scheduler.processScheduledCampaigns();

      expect(immediateSend.status).toBe('SENDING'); // unchanged
    });

    it('does not recover an already-settled campaign (SENT or FAILED)', async () => {
      const alreadySent = makeCampaign({
        id: 'sent-1',
        status: 'SENT',
        isScheduled: true,
        sentAt: new Date(NOW.getTime() - STALE_SENDING_TIMEOUT_MS - 1),
        updatedAt: new Date(NOW.getTime() - STALE_SENDING_TIMEOUT_MS - 1),
      });
      const alreadyFailed = makeCampaign({
        id: 'failed-1',
        status: 'FAILED',
        isScheduled: true,
        sentAt: null,
        updatedAt: new Date(NOW.getTime() - STALE_SENDING_TIMEOUT_MS - 1),
      });
      prisma.notificationCampaign.updateMany = fakeUpdateMany([alreadySent, alreadyFailed]);

      await scheduler.processScheduledCampaigns();

      expect(alreadySent.status).toBe('SENT');
      expect(alreadyFailed.status).toBe('FAILED');
    });

    it('logs a safe count-only warning when campaigns were recovered', async () => {
      const stale = makeCampaign({
        id: 'stale-1',
        status: 'SENDING',
        updatedAt: new Date(NOW.getTime() - STALE_SENDING_TIMEOUT_MS - 1),
      });
      prisma.notificationCampaign.updateMany = fakeUpdateMany([stale]);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await scheduler.processScheduledCampaigns();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0][0]);
      expect(message).toContain('Recovered 1 stale scheduled campaign claim(s)');
      expect(message).toContain(`${STALE_SENDING_TIMEOUT_MS}ms`);
      expect(message).not.toContain('stale-1'); // count-only, no campaign IDs/payload
    });

    it('logs nothing when zero campaigns were recovered', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await scheduler.processScheduledCampaigns(); // default mocks: updateMany -> { count: 0 }

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('runs recovery before querying due SCHEDULED campaigns', async () => {
      await scheduler.processScheduledCampaigns();

      const updateManyOrder = prisma.notificationCampaign.updateMany.mock.invocationCallOrder[0];
      const findManyOrder = prisma.notificationCampaign.findMany.mock.invocationCallOrder[0];
      expect(updateManyOrder).toBeLessThan(findManyOrder);
    });

    it('does not requeue or dispatch a recovered stale campaign — it becomes FAILED, not SCHEDULED', async () => {
      const stale = makeCampaign({
        id: 'stale-1',
        status: 'SENDING',
        updatedAt: new Date(NOW.getTime() - STALE_SENDING_TIMEOUT_MS - 1),
      });
      prisma.notificationCampaign.updateMany = fakeUpdateMany([stale]);

      await scheduler.processScheduledCampaigns();

      expect(stale.status).toBe('FAILED');
      expect(stale.status).not.toBe('SCHEDULED');
      expect(campaignsService.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('claimAndDispatch atomicity', () => {
    it('claims via a guarded updateMany (id + status SCHEDULED) and dispatches only when claimed', async () => {
      prisma.notificationCampaign.updateMany.mockResolvedValue({ count: 1 });
      const campaign = { id: 'c1', status: 'SENDING' };
      prisma.notificationCampaign.findUniqueOrThrow.mockResolvedValue(campaign);
      campaignsService.dispatch.mockResolvedValue(campaign);

      await scheduler.claimAndDispatch('c1');

      expect(prisma.notificationCampaign.updateMany).toHaveBeenCalledWith({
        where: { id: 'c1', status: 'SCHEDULED' },
        data: { status: 'SENDING' },
      });
      expect(prisma.notificationCampaign.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'c1' },
      });
      expect(campaignsService.dispatch).toHaveBeenCalledWith(campaign);
    });

    it('does not dispatch when claimed.count is 0 (already claimed elsewhere)', async () => {
      prisma.notificationCampaign.updateMany.mockResolvedValue({ count: 0 });

      await scheduler.claimAndDispatch('c1');

      expect(prisma.notificationCampaign.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(campaignsService.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('per-campaign failure isolation', () => {
    it('continues to the next due campaign when one throws, and resolves without an unhandled rejection', async () => {
      prisma.notificationCampaign.findMany.mockResolvedValue([{ id: 'bad-1' }, { id: 'good-1' }]);
      prisma.notificationCampaign.updateMany.mockImplementation(async ({ where }: any) => {
        if (where.id === 'bad-1') {
          throw new Error('DB connection lost');
        }
        if (where.id === 'good-1') {
          return { count: 1 };
        }
        return { count: 0 }; // the initial stale-recovery call
      });
      const goodCampaign = { id: 'good-1', status: 'SENDING' };
      prisma.notificationCampaign.findUniqueOrThrow.mockResolvedValue(goodCampaign);
      campaignsService.dispatch.mockResolvedValue(goodCampaign);
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(scheduler.processScheduledCampaigns()).resolves.toBeUndefined();

      expect(campaignsService.dispatch).toHaveBeenCalledTimes(1);
      expect(campaignsService.dispatch).toHaveBeenCalledWith(goodCampaign);
      const loggedMessages = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(loggedMessages.some((m) => m.includes('bad-1') && m.includes('DB connection lost'))).toBe(
        true,
      );
    });
  });
});
