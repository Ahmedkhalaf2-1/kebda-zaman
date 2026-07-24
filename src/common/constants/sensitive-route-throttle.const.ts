import { seconds, ThrottlerOptions } from '@nestjs/throttler';

/**
 * Stricter per-route rate limit for sensitive non-auth endpoints (plan §5.6:
 * "stricter per-route on ... /promos/validate, /payments/webhook"). Same
 * limit as AUTH_THROTTLE (auth-throttle.const.ts) — same sensitivity class,
 * kept as a separate constant so this module doesn't depend on the auth module.
 */
export const SENSITIVE_ROUTE_THROTTLE: Record<string, ThrottlerOptions> = {
  default: { limit: 20, ttl: seconds(60) },
};
