import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  OrderTrackingResponseDto,
  OrderTrackingSource,
  toOrderTrackingResponse,
} from '../../common/mappers/order-tracking-response.mapper';
import { UpdateDriverLocationDto } from './dto/update-driver-location.dto';

/** A sample captured more than this long before the server receives it is
 * rejected outright — generous relative to the 5-10s target cadence (covers
 * a real connectivity gap/retry) while still bounding how old a "live"
 * sample can claim to be. */
export const MAX_LOCATION_AGE_SECONDS = 300;

/** A sample timestamped more than this far in the future (server clock) is
 * rejected — tolerates ordinary client/server clock drift without accepting
 * clearly wrong or spoofed timestamps. */
export const MAX_LOCATION_FUTURE_SKEW_SECONDS = 60;

export interface LocationAckResponseDto {
  /** `false` when the upload was validated and accepted but not persisted —
   * an out-of-order/duplicate/retried sample that was not newer than what's
   * already stored for this exact assignment. Not an error: the driver's app
   * should treat this the same as `true` (nothing to retry). */
  accepted: boolean;
  assignmentVersion: number;
  receivedAt: string;
}

const trackingSelect = {
  status: true,
  driverId: true,
  driverAssignmentVersion: true,
  driver: { select: { fullName: true, phone: true, deletedAt: true } },
  driverLocation: true,
} satisfies Prisma.OrderSelect;

@Injectable()
export class DriverLocationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * DRIVER: uploads the single latest location sample for an order currently
   * assigned to the caller. See DRIVER_DELIVERY_API_CONTRACT.md's tracking
   * lifecycle section for the full rule set enforced here.
   */
  async recordLocation(
    driverId: string,
    orderId: string,
    dto: UpdateDriverLocationDto,
  ): Promise<LocationAckResponseDto> {
    const capturedAt = new Date(dto.capturedAt);
    const now = new Date();
    this.assertCapturedAtWithinBounds(capturedAt, now);

    // Fast-fail pre-check outside any transaction — purely so a rejected
    // request gets the RIGHT error code/message. The authoritative guard
    // against every race (reassignment, unassignment, status change, or a
    // reassignment back to this same driver) is the atomic claim inside the
    // transaction below, not this read.
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, driverId },
      select: { deliveryMethod: true, status: true, driverAssignmentVersion: true },
    });
    if (!order) {
      throw new NotFoundException({
        message: 'Order not found or not assigned to you',
        code: 'ORDER_NOT_ASSIGNED',
      });
    }
    if (order.deliveryMethod !== 'DELIVERY') {
      throw new UnprocessableEntityException({
        message: 'Only DELIVERY orders can be tracked',
        code: 'NOT_A_DELIVERY_ORDER',
      });
    }
    if (order.status !== 'OUT_FOR_DELIVERY') {
      throw new UnprocessableEntityException({
        message: `Cannot record a location while the order is ${order.status}`,
        code: 'ORDER_NOT_OUT_FOR_DELIVERY',
      });
    }
    if (dto.assignmentVersion !== order.driverAssignmentVersion) {
      throw new ConflictException({
        message: 'This assignment is no longer current',
        code: 'ASSIGNMENT_VERSION_MISMATCH',
        details: { currentAssignmentVersion: order.driverAssignmentVersion },
      });
    }

    const accepted = await this.prisma.$transaction(async (tx) => {
      // Atomic re-validation — the same optimistic-claim idiom
      // OrdersService.runStatusTransition/assignDriver use: this WHERE only
      // matches if the order is STILL assigned to this driver, STILL
      // OUT_FOR_DELIVERY, and STILL at this exact assignment version at the
      // instant the UPDATE actually executes. A concurrent reassignment,
      // unassignment, or delivery-completion that commits first makes this
      // claim fail (count 0) instead of racing the location write below —
      // Postgres's row lock on the Order row is what makes THIS check
      // atomic. It says nothing about whether THIS write should win over
      // another concurrent, equally-valid write for the same assignment —
      // that's a separate invariant, enforced below.
      const claimed = await tx.order.updateMany({
        where: {
          id: orderId,
          driverId,
          status: 'OUT_FOR_DELIVERY',
          driverAssignmentVersion: dto.assignmentVersion,
        },
        data: { updatedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          message: 'Order or assignment state changed before this location could be recorded',
          code: 'ASSIGNMENT_VERSION_MISMATCH',
        });
      }

      // The "never move backward" invariant is enforced HERE, in the write
      // itself, via a conditional `ON CONFLICT ... DO UPDATE ... WHERE` —
      // not by a preceding `findUnique` + an unconditional upsert. That
      // matters: Prisma's `.upsert()` compiles to `INSERT ... ON CONFLICT
      // (orderId) DO UPDATE SET ... WHERE (orderId = $1 AND 1=1)` (verified
      // against this project's Prisma/Postgres versions) — i.e. the DO
      // UPDATE branch is UNCONDITIONAL once a conflict is found. A prior
      // `tx.orderDriverLocation.findUnique()` read followed by an
      // app-level "is this newer?" decision, then an unconditional
      // `.upsert()`, is a classic TOCTOU: it only produced the right answer
      // in practice because every write for this order also happens to
      // funnel through the SAME Order-row claim above, which incidentally
      // serializes the two transactions end-to-end — a correct write for a
      // DIFFERENT table (OrderDriverLocation) must not depend on an
      // incidental side effect of a lock on a DIFFERENT row for a DIFFERENT
      // purpose; a later refactor of that claim (e.g. dropping the
      // `updatedAt` touch as "dead code") could silently reintroduce the
      // race. This single statement is self-evidently correct by
      // inspection and needs no such reasoning:
      //  - No existing row (first-ever sample for this order) → the INSERT
      //    branch always applies; two concurrent first uploads still can't
      //    both "win" — Postgres's own conflict handling on the unique
      //    `orderId` key serializes them, and the loser re-evaluates the
      //    WHERE below against the winner's now-committed row.
      //  - Existing row from a strictly older (superseded) assignment
      //    version → always overwritten regardless of its capturedAt —
      //    comparing timestamps across two different assignments is
      //    meaningless, and an old assignment must never win just because
      //    its clock reads later.
      //  - Existing row from the SAME assignment version → overwritten only
      //    if the incoming sample is strictly newer (`capturedAt` greater).
      //    An exactly-equal timestamp is deterministically treated as "not
      //    newer" (first arrival wins ties), matching a duplicate/retried
      //    request being safely ignored rather than refreshing `receivedAt`.
      const rows = await tx.$queryRaw<Array<{ accepted: boolean }>>(Prisma.sql`
        INSERT INTO "OrderDriverLocation"
          ("orderId", "driverId", "assignmentVersion", "latitude", "longitude",
           "accuracyMeters", "headingDegrees", "speedMps", "capturedAt", "receivedAt", "updatedAt")
        VALUES
          (${orderId}::uuid, ${driverId}::uuid, ${dto.assignmentVersion},
           ${dto.latitude}, ${dto.longitude}, ${dto.accuracyMeters ?? null},
           ${dto.headingDegrees ?? null}, ${dto.speedMps ?? null}, ${capturedAt}, ${now}, ${now})
        ON CONFLICT ("orderId") DO UPDATE SET
          "driverId" = EXCLUDED."driverId",
          "assignmentVersion" = EXCLUDED."assignmentVersion",
          "latitude" = EXCLUDED."latitude",
          "longitude" = EXCLUDED."longitude",
          "accuracyMeters" = EXCLUDED."accuracyMeters",
          "headingDegrees" = EXCLUDED."headingDegrees",
          "speedMps" = EXCLUDED."speedMps",
          "capturedAt" = EXCLUDED."capturedAt",
          "receivedAt" = EXCLUDED."receivedAt",
          "updatedAt" = EXCLUDED."updatedAt"
        WHERE
          "OrderDriverLocation"."assignmentVersion" < EXCLUDED."assignmentVersion"
          OR (
            "OrderDriverLocation"."assignmentVersion" = EXCLUDED."assignmentVersion"
            AND "OrderDriverLocation"."capturedAt" < EXCLUDED."capturedAt"
          )
        RETURNING true AS accepted
      `);
      return rows.length === 1;
    });

    return { accepted, assignmentVersion: dto.assignmentVersion, receivedAt: now.toISOString() };
  }

  /** CUSTOMER: ownership-scoped tracking read — same convention as OrdersService.getOrder. */
  async getCustomerTracking(userId: string, orderId: string): Promise<OrderTrackingResponseDto> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      select: trackingSelect,
    });
    if (!order) {
      throw new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
    }
    return toOrderTrackingResponse(orderId, order as OrderTrackingSource);
  }

  /** ADMIN/CASHIER: tracking read, no ownership restriction — same convention as OrdersService.adminGetOrder. */
  async getAdminTracking(orderId: string): Promise<OrderTrackingResponseDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: trackingSelect,
    });
    if (!order) {
      throw new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
    }
    return toOrderTrackingResponse(orderId, order as OrderTrackingSource);
  }

  private assertCapturedAtWithinBounds(capturedAt: Date, now: Date): void {
    const ageSeconds = (now.getTime() - capturedAt.getTime()) / 1000;
    if (ageSeconds > MAX_LOCATION_AGE_SECONDS) {
      throw new UnprocessableEntityException({
        message: `Location sample is too old (captured ${Math.round(ageSeconds)}s ago, max ${MAX_LOCATION_AGE_SECONDS}s)`,
        code: 'LOCATION_TOO_OLD',
      });
    }
    if (ageSeconds < -MAX_LOCATION_FUTURE_SKEW_SECONDS) {
      throw new UnprocessableEntityException({
        message: `Location sample is timestamped ${Math.round(-ageSeconds)}s in the future (max ${MAX_LOCATION_FUTURE_SKEW_SECONDS}s)`,
        code: 'LOCATION_TIMESTAMP_IN_FUTURE',
      });
    }
  }
}
