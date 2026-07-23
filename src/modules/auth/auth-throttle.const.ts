import { seconds, ThrottlerOptions } from '@nestjs/throttler';

/**
 * Stricter per-route rate limit for sensitive auth endpoints (plan §5.6:
 * "stricter per-route on /auth/login, /auth/register" — extended here to
 * admin login, which is the same sensitivity class).
 */
export const AUTH_THROTTLE: Record<string, ThrottlerOptions> = {
  default: { limit: 20, ttl: seconds(60) },
};
