import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface Entry {
  failures: number;
  firstFailureAt: number;
  lockedUntil?: number;
}

/**
 * In-memory brute-force tracker for login endpoints (plan §5.6): after
 * `maxAttempts` failed logins for the same key within the tracking window,
 * further attempts are locked out (423) for `lockMinutes`, regardless of
 * whether the credentials presented are now correct.
 *
 * Single-instance in-memory store, matching the plan's explicit guidance not
 * to introduce Redis until multi-instance deployment requires it.
 */
@Injectable()
export class BruteForceService {
  private readonly attempts = new Map<string, Entry>();

  constructor(private readonly config: ConfigService) {}

  private get maxAttempts(): number {
    return this.config.get<number>('bruteForce.maxAttempts') ?? 5;
  }

  private get lockMs(): number {
    return (this.config.get<number>('bruteForce.lockMinutes') ?? 15) * 60_000;
  }

  static key(scope: string, ip: string, email: string): string {
    return `${scope}:${ip}:${email.toLowerCase()}`;
  }

  /** Throws 423 if the key is currently locked out. */
  assertNotLocked(key: string): void {
    const entry = this.attempts.get(key);
    if (entry?.lockedUntil && entry.lockedUntil > Date.now()) {
      throw new HttpException(
        {
          message: 'Too many failed login attempts. Try again later.',
          code: 'ACCOUNT_LOCKED',
        },
        HttpStatus.LOCKED,
      );
    }
  }

  recordFailure(key: string): void {
    const now = Date.now();
    const existing = this.attempts.get(key);
    // Start a fresh window if there's no entry, or the previous window/lock has expired.
    const windowExpired = existing && now - existing.firstFailureAt > this.lockMs;
    if (!existing || windowExpired) {
      this.attempts.set(key, { failures: 1, firstFailureAt: now });
      return;
    }
    existing.failures += 1;
    if (existing.failures >= this.maxAttempts) {
      existing.lockedUntil = now + this.lockMs;
    }
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }
}
