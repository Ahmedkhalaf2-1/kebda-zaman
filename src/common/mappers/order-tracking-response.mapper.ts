import { OrderDriverLocation, OrderStatus } from '@prisma/client';

/**
 * The 5 states DRIVER_DELIVERY_API_CONTRACT.md documents for
 * `GET /orders/:id/tracking` / `GET /admin/orders/:id/tracking`:
 *  - NOT_STARTED: order hasn't reached OUT_FOR_DELIVERY yet (includes every
 *    PICKUP order, which never will).
 *  - WAITING_FOR_LOCATION: OUT_FOR_DELIVERY, an active driver is assigned,
 *    but no location sample exists yet for the CURRENT assignment version.
 *  - ACTIVE: a location sample for the current assignment exists and is
 *    within the freshness threshold.
 *  - STALE: same as ACTIVE but older than the freshness threshold — the
 *    real coordinates are still returned (with their real timestamps), just
 *    never presented as current.
 *  - ENDED: the order reached a terminal status, was unassigned mid-delivery,
 *    or its driver was deactivated — tracking is over/unavailable.
 */
export type OrderTrackingState =
  'NOT_STARTED' | 'WAITING_FOR_LOCATION' | 'ACTIVE' | 'STALE' | 'ENDED';

/** A location sample is "fresh" (ACTIVE) for this many seconds after its
 * `capturedAt` — roughly 3-6x the documented 5-10s driver upload cadence, so
 * ordinary network jitter or one missed beat doesn't flip the state, while a
 * driver who has genuinely stopped reporting is flagged promptly. */
export const TRACKING_FRESHNESS_THRESHOLD_SECONDS = 30;

const TERMINAL_ORDER_STATUSES: OrderStatus[] = ['DELIVERED', 'PICKED_UP', 'CANCELLED'];

export interface OrderTrackingLocationDto {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  headingDegrees: number | null;
  speedMps: number | null;
  /** When the device captured this fix. */
  capturedAt: string;
  /** When this server received/accepted it — always >= capturedAt in
   * practice, kept distinct so a client can see both network delay and GPS
   * fix age independently. */
  receivedAt: string;
}

export interface OrderTrackingResponseDto {
  orderId: string;
  state: OrderTrackingState;
  /** Only non-null while `state` is WAITING_FOR_LOCATION/ACTIVE/STALE — never
   * exposed before the delivery starts or after tracking has ended. */
  driverName: string | null;
  driverPhone: string | null;
  /** Only non-null while `state` is ACTIVE or STALE. */
  location: OrderTrackingLocationDto | null;
  /** Freshness indicator derived from `location.capturedAt` — `null` exactly
   * when `location` is `null`. Complements the qualitative `state` (ACTIVE
   * vs STALE) with a quantitative "how old" figure for display. */
  locationAgeSeconds: number | null;
}

/** Shape `DriverLocationService` selects via Prisma — a plain Order row plus
 * the two relations tracking needs, nothing else (no items/payments/etc). */
export interface OrderTrackingSource {
  status: OrderStatus;
  driverId: string | null;
  driverAssignmentVersion: number;
  driver: { fullName: string; phone: string | null; deletedAt: Date | null } | null;
  driverLocation: OrderDriverLocation | null;
}

function deriveTrackingState(order: OrderTrackingSource): OrderTrackingState {
  if (TERMINAL_ORDER_STATUSES.includes(order.status)) {
    return 'ENDED';
  }
  if (order.status !== 'OUT_FOR_DELIVERY') {
    return 'NOT_STARTED';
  }
  // From here: OUT_FOR_DELIVERY. Tracking requires a currently-assigned,
  // active driver — an admin may unassign mid-delivery, or the assigned
  // driver may have since been deactivated; either ends tracking outright.
  if (!order.driverId || !order.driver || order.driver.deletedAt !== null) {
    return 'ENDED';
  }

  const location = order.driverLocation;
  // No sample yet, OR the stored sample belongs to a DIFFERENT assignment
  // (a prior driver's leftover row, or this same driver's PRIOR stint after
  // being reassigned away and back) — never shown as this assignment's
  // location, regardless of how recent it looks.
  if (!location || location.assignmentVersion !== order.driverAssignmentVersion) {
    return 'WAITING_FOR_LOCATION';
  }

  const ageMs = Date.now() - location.capturedAt.getTime();
  return ageMs <= TRACKING_FRESHNESS_THRESHOLD_SECONDS * 1000 ? 'ACTIVE' : 'STALE';
}

export function toOrderTrackingResponse(
  orderId: string,
  order: OrderTrackingSource,
): OrderTrackingResponseDto {
  const state = deriveTrackingState(order);
  const showDriverInfo =
    state === 'WAITING_FOR_LOCATION' || state === 'ACTIVE' || state === 'STALE';
  const showLocation = state === 'ACTIVE' || state === 'STALE';
  const sample = showLocation ? order.driverLocation : null;

  const location: OrderTrackingLocationDto | null = sample
    ? {
        latitude: sample.latitude.toNumber(),
        longitude: sample.longitude.toNumber(),
        accuracyMeters: sample.accuracyMeters?.toNumber() ?? null,
        headingDegrees: sample.headingDegrees?.toNumber() ?? null,
        speedMps: sample.speedMps?.toNumber() ?? null,
        capturedAt: sample.capturedAt.toISOString(),
        receivedAt: sample.receivedAt.toISOString(),
      }
    : null;

  return {
    orderId,
    state,
    driverName: showDriverInfo ? (order.driver?.fullName ?? null) : null,
    driverPhone: showDriverInfo ? (order.driver?.phone ?? null) : null,
    location,
    locationAgeSeconds: sample
      ? Math.max(0, Math.round((Date.now() - sample.capturedAt.getTime()) / 1000))
      : null,
  };
}
