import { IsDateString, IsInt, IsNumber, IsOptional, Min, Max } from 'class-validator';

/**
 * Driver's GPS location upload (Phase 2 live tracking). `IsNumber()` already
 * rejects NaN/Infinity by default (see checkout.dto.ts's DeliveryAddressDto
 * for the same convention) — combined with the range checks below this
 * satisfies "finite numeric values, coordinate ranges" validation.
 *
 * Documented limits (also in DRIVER_DELIVERY_API_CONTRACT.md):
 *  - accuracyMeters: 0-10000 — beyond ~10km the fix is unusable (e.g. a stale
 *    cell-tower-only estimate), not a real GPS accuracy figure.
 *  - headingDegrees: 0-359.999 — compass bearing, 360 itself is not emitted
 *    (wraps to 0).
 *  - speedMps: 0-100 — ~360 km/h, a generous ceiling that only exists to
 *    reject clearly corrupt data, not to model any real delivery speed.
 */
export class UpdateDriverLocationDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  /** When the device actually captured this fix (ISO 8601) — never the
   * upload time. See OrdersService/DriverLocationService for the separate
   * server-side `receivedAt` and the age/future-skew bounds enforced against
   * this value. */
  @IsDateString()
  capturedAt!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10_000)
  accuracyMeters?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(359.999)
  headingDegrees?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  speedMps?: number;

  /**
   * The assignment identifier this sample is for — must equal the value the
   * driver last read on this order (`DriverOrderResponseDto.assignmentVersion`,
   * itself `Order.driverAssignmentVersion`). A mismatch means the driver's
   * app is acting on an obsolete assignment (reassigned away, including back
   * to the same driver) — rejected with 409 ASSIGNMENT_VERSION_MISMATCH
   * rather than silently accepted, however plausible the coordinates look.
   */
  @IsInt()
  @Min(0)
  assignmentVersion!: number;
}
