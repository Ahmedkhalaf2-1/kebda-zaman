import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DriverLocationService,
  MAX_LOCATION_AGE_SECONDS,
  MAX_LOCATION_FUTURE_SKEW_SECONDS,
} from './driver-location.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateDriverLocationDto } from './dto/update-driver-location.dto';

function validDto(overrides: Partial<UpdateDriverLocationDto> = {}): UpdateDriverLocationDto {
  return {
    latitude: 21.5433,
    longitude: 39.1728,
    capturedAt: new Date().toISOString(),
    assignmentVersion: 3,
    ...overrides,
  };
}

/** Extracts the interpolated parameters from a `Prisma.sql` tagged-template
 * argument, in interpolation order — the only way to assert on what a raw
 * query actually sent without a real DB (see driver-location.spec.ts /
 * driver-location.concurrency.driver-location-concurrency-spec.ts for the
 * real-Postgres behavioral proof of the WHERE-guarded upsert itself). */
function sqlValues(arg: unknown): unknown[] {
  return (arg as Prisma.Sql).values;
}

describe('DriverLocationService', () => {
  let prisma: {
    order: { findFirst: jest.Mock; findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let txOrderUpdateMany: jest.Mock;
  let txQueryRaw: jest.Mock;
  let service: DriverLocationService;

  function build() {
    txOrderUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    txQueryRaw = jest.fn().mockResolvedValue([{ accepted: true }]);
    const tx = {
      order: { updateMany: txOrderUpdateMany },
      $queryRaw: txQueryRaw,
    };
    prisma = {
      order: { findFirst: jest.fn(), findUnique: jest.fn() },
      $transaction: jest.fn((callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    };
    service = new DriverLocationService(prisma as unknown as PrismaService);
  }

  beforeEach(() => {
    build();
  });

  // ===========================================================================
  describe('recordLocation — timestamp bounds', () => {
    it('rejects a sample older than MAX_LOCATION_AGE_SECONDS', async () => {
      const tooOld = new Date(Date.now() - (MAX_LOCATION_AGE_SECONDS + 30) * 1000).toISOString();
      await expect(
        service.recordLocation('driver-1', 'order-1', validDto({ capturedAt: tooOld })),
      ).rejects.toMatchObject({ response: { code: 'LOCATION_TOO_OLD' } });
      expect(prisma.order.findFirst).not.toHaveBeenCalled();
    });

    it('accepts a sample right at the age boundary', async () => {
      prisma.order.findFirst.mockResolvedValue({
        deliveryMethod: 'DELIVERY',
        status: 'OUT_FOR_DELIVERY',
        driverAssignmentVersion: 3,
      });
      const atBoundary = new Date(Date.now() - (MAX_LOCATION_AGE_SECONDS - 1) * 1000).toISOString();
      await expect(
        service.recordLocation('driver-1', 'order-1', validDto({ capturedAt: atBoundary })),
      ).resolves.toMatchObject({ accepted: true });
    });

    it('rejects a sample timestamped further in the future than MAX_LOCATION_FUTURE_SKEW_SECONDS', async () => {
      const tooFuture = new Date(
        Date.now() + (MAX_LOCATION_FUTURE_SKEW_SECONDS + 30) * 1000,
      ).toISOString();
      await expect(
        service.recordLocation('driver-1', 'order-1', validDto({ capturedAt: tooFuture })),
      ).rejects.toMatchObject({ response: { code: 'LOCATION_TIMESTAMP_IN_FUTURE' } });
    });
  });

  // ===========================================================================
  describe('recordLocation — ownership and lifecycle', () => {
    it('404s when the order is not assigned to the caller (or does not exist)', async () => {
      prisma.order.findFirst.mockResolvedValue(null);
      await expect(service.recordLocation('driver-1', 'order-1', validDto())).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a PICKUP order', async () => {
      prisma.order.findFirst.mockResolvedValue({
        deliveryMethod: 'PICKUP',
        status: 'OUT_FOR_DELIVERY',
        driverAssignmentVersion: 3,
      });
      await expect(service.recordLocation('driver-1', 'order-1', validDto())).rejects.toMatchObject(
        { response: { code: 'NOT_A_DELIVERY_ORDER' } },
      );
    });

    it.each(['PENDING', 'CONFIRMED', 'PREPARING', 'DELIVERED', 'CANCELLED'])(
      'rejects when the order is %s (not OUT_FOR_DELIVERY)',
      async (status) => {
        prisma.order.findFirst.mockResolvedValue({
          deliveryMethod: 'DELIVERY',
          status,
          driverAssignmentVersion: 3,
        });
        await expect(
          service.recordLocation('driver-1', 'order-1', validDto()),
        ).rejects.toMatchObject({ response: { code: 'ORDER_NOT_OUT_FOR_DELIVERY' } });
      },
    );

    it('rejects an obsolete assignment version', async () => {
      prisma.order.findFirst.mockResolvedValue({
        deliveryMethod: 'DELIVERY',
        status: 'OUT_FOR_DELIVERY',
        driverAssignmentVersion: 5,
      });
      await expect(
        service.recordLocation('driver-1', 'order-1', validDto({ assignmentVersion: 3 })),
      ).rejects.toMatchObject({
        response: { code: 'ASSIGNMENT_VERSION_MISMATCH', details: { currentAssignmentVersion: 5 } },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('accepts a valid upload from the currently assigned driver', async () => {
      prisma.order.findFirst.mockResolvedValue({
        deliveryMethod: 'DELIVERY',
        status: 'OUT_FOR_DELIVERY',
        driverAssignmentVersion: 3,
      });
      const result = await service.recordLocation('driver-1', 'order-1', validDto());
      expect(result.accepted).toBe(true);
      expect(txQueryRaw).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  describe('recordLocation — atomic claim (concurrency)', () => {
    it('rejects with 409 when the claim loses a concurrent race (reassignment/status change/unassignment)', async () => {
      prisma.order.findFirst.mockResolvedValue({
        deliveryMethod: 'DELIVERY',
        status: 'OUT_FOR_DELIVERY',
        driverAssignmentVersion: 3,
      });
      txOrderUpdateMany.mockResolvedValue({ count: 0 });
      await expect(service.recordLocation('driver-1', 'order-1', validDto())).rejects.toMatchObject(
        { response: { code: 'ASSIGNMENT_VERSION_MISMATCH' } },
      );
      expect(txQueryRaw).not.toHaveBeenCalled();
    });

    it('claims with driverId + OUT_FOR_DELIVERY + the exact assignment version', async () => {
      prisma.order.findFirst.mockResolvedValue({
        deliveryMethod: 'DELIVERY',
        status: 'OUT_FOR_DELIVERY',
        driverAssignmentVersion: 7,
      });
      await service.recordLocation('driver-1', 'order-1', validDto({ assignmentVersion: 7 }));
      expect(txOrderUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'order-1',
            driverId: 'driver-1',
            status: 'OUT_FOR_DELIVERY',
            driverAssignmentVersion: 7,
          },
        }),
      );
    });
  });

  // ===========================================================================
  describe('recordLocation — atomic write (raw conditional upsert)', () => {
    beforeEach(() => {
      prisma.order.findFirst.mockResolvedValue({
        deliveryMethod: 'DELIVERY',
        status: 'OUT_FOR_DELIVERY',
        driverAssignmentVersion: 3,
      });
    });

    it('issues exactly one raw query (no preceding read) carrying the right parameters, in order', async () => {
      const capturedAt = new Date(Date.now() - 5_000).toISOString();
      await service.recordLocation(
        'driver-1',
        'order-1',
        validDto({ assignmentVersion: 3, latitude: 21.1, longitude: 39.2, capturedAt }),
      );

      expect(txQueryRaw).toHaveBeenCalledTimes(1);
      const values = sqlValues(txQueryRaw.mock.calls[0][0]);
      // orderId, driverId, assignmentVersion, latitude, longitude, accuracy, heading, speed, capturedAt, receivedAt, updatedAt
      expect(values[0]).toBe('order-1');
      expect(values[1]).toBe('driver-1');
      expect(values[2]).toBe(3);
      expect(values[3]).toBe(21.1);
      expect(values[4]).toBe(39.2);
      expect(values[5]).toBeNull(); // accuracyMeters not supplied
      expect(values[6]).toBeNull(); // headingDegrees not supplied
      expect(values[7]).toBeNull(); // speedMps not supplied
      expect((values[8] as Date).toISOString()).toBe(capturedAt);
    });

    it('the raw SQL text guards the DO UPDATE branch on assignmentVersion/capturedAt ordering', async () => {
      await service.recordLocation('driver-1', 'order-1', validDto());
      const sql = (txQueryRaw.mock.calls[0][0] as Prisma.Sql).sql;
      expect(sql).toContain('ON CONFLICT');
      expect(sql).toContain('"assignmentVersion" < EXCLUDED."assignmentVersion"');
      expect(sql).toContain('"capturedAt" < EXCLUDED."capturedAt"');
    });

    it('reports accepted:true when the raw query returns a row', async () => {
      txQueryRaw.mockResolvedValue([{ accepted: true }]);
      const result = await service.recordLocation('driver-1', 'order-1', validDto());
      expect(result.accepted).toBe(true);
    });

    it('reports accepted:false when the raw query returns no rows (WHERE guard rejected the write, e.g. a stale/duplicate sample)', async () => {
      txQueryRaw.mockResolvedValue([]);
      const result = await service.recordLocation('driver-1', 'order-1', validDto());
      expect(result.accepted).toBe(false);
    });

    it('never issues a preceding read of OrderDriverLocation — the ordering decision lives entirely in the write', async () => {
      await service.recordLocation('driver-1', 'order-1', validDto());
      // Only the Order claim + the one raw query — no separate findUnique/upsert calls exist on this service anymore.
      expect(txOrderUpdateMany).toHaveBeenCalledTimes(1);
      expect(txQueryRaw).toHaveBeenCalledTimes(1);
    });
  });
});
