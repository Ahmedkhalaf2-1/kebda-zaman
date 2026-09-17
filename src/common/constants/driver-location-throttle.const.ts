import { seconds, ThrottlerOptions } from '@nestjs/throttler';

/**
 * Per-route rate limit for PUT /driver/orders/:id/location — deliberately
 * higher than the global default (100 req/60s across ALL of a driver's
 * traffic) and higher than AUTH_THROTTLE/SENSITIVE_ROUTE_THROTTLE (20 req/60s,
 * sized for occasional sensitive actions, not a moving GPS feed).
 *
 * Sizing: target cadence is one update every 5-10s per actively-tracked order
 * (DRIVER_DELIVERY_API_CONTRACT.md). 60 req/60s (1/sec sustained) comfortably
 * covers a single order updating as often as every 2s (generous burst/retry
 * headroom over the 5-10s target) or up to ~10 simultaneously OUT_FOR_DELIVERY
 * orders each updating every 10s — a batch-delivery upper bound well beyond
 * what one driver realistically carries — while still bounding abuse to a
 * fixed, moderate ceiling per driver account.
 */
export const DRIVER_LOCATION_THROTTLE: Record<string, ThrottlerOptions> = {
  default: { limit: 60, ttl: seconds(60) },
};
