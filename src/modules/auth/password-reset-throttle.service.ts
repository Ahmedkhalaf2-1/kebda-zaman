import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

interface Entry {
  count: number;
  windowStart: number;
  lastRequestAt: number;
}

/**
 * In-memory per-email rate limiter for POST /auth/forgot-password —
 * independent of (and in addition to) the per-IP `@Throttle` on the route.
 * Single-instance in-memory store, same rationale/convention as
 * BruteForceService (not introducing Redis until multi-instance deployment
 * requires it).
 *
 * Two rules, both keyed by the *normalized* (trimmed, lowercased) submitted
 * email string — applied identically whether or not that email actually has
 * an account, so neither rule leaks account existence:
 *  - Resend cooldown: at most one request per email per `cooldownMs`.
 *  - Abuse cap: at most `maxPerWindow` requests per email per `windowMs`.
 *
 * `assertAllowedAndRecord` does its check AND its record synchronously, with
 * no `await` between them — Node's single-threaded event loop makes this
 * atomic, so two genuinely concurrent requests for the same email can never
 * both pass (closes the "concurrent requests" duplicate-email race named in
 * the task requirements without needing a DB round trip or a lock).
 */
@Injectable()
export class PasswordResetThrottleService {
  private readonly entries = new Map<string, Entry>();

  private readonly cooldownMs = 60_000;
  private readonly windowMs = 15 * 60_000;
  private readonly maxPerWindow = 3;

  private static normalize(email: string): string {
    return email.trim().toLowerCase();
  }

  /** Throws 429 if this email is within its resend cooldown or has exceeded
   * its request cap for the current window; otherwise records this request. */
  assertAllowedAndRecord(email: string): void {
    const key = PasswordResetThrottleService.normalize(email);
    const now = Date.now();
    const entry = this.entries.get(key);

    if (entry && now - entry.lastRequestAt < this.cooldownMs) {
      throw new HttpException(
        {
          message: 'Please wait before requesting another password reset email.',
          code: 'PASSWORD_RESET_COOLDOWN',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const windowActive = entry && now - entry.windowStart < this.windowMs;
    if (windowActive && entry.count >= this.maxPerWindow) {
      throw new HttpException(
        {
          message: 'Too many password reset requests for this email. Try again later.',
          code: 'PASSWORD_RESET_RATE_LIMITED',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (windowActive) {
      entry.count += 1;
      entry.lastRequestAt = now;
    } else {
      this.entries.set(key, { count: 1, windowStart: now, lastRequestAt: now });
    }
  }
}
