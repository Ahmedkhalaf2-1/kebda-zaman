import { HttpException } from '@nestjs/common';
import { PasswordResetThrottleService } from './password-reset-throttle.service';

describe('PasswordResetThrottleService', () => {
  let service: PasswordResetThrottleService;

  beforeEach(() => {
    service = new PasswordResetThrottleService();
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows the first request for an email', () => {
    expect(() => service.assertAllowedAndRecord('user@example.com')).not.toThrow();
  });

  it('rejects a second request for the same email within the resend cooldown', () => {
    service.assertAllowedAndRecord('user@example.com');
    expect(() => service.assertAllowedAndRecord('user@example.com')).toThrow(HttpException);
    try {
      service.assertAllowedAndRecord('user@example.com');
    } catch (error) {
      expect((error as HttpException).getResponse()).toMatchObject({
        code: 'PASSWORD_RESET_COOLDOWN',
      });
      expect((error as HttpException).getStatus()).toBe(429);
    }
  });

  it('normalizes email case/whitespace so the cooldown cannot be bypassed by casing', () => {
    service.assertAllowedAndRecord('User@Example.com');
    expect(() => service.assertAllowedAndRecord('  user@example.com  ')).toThrow(HttpException);
  });

  it('treats different emails independently', () => {
    service.assertAllowedAndRecord('a@example.com');
    expect(() => service.assertAllowedAndRecord('b@example.com')).not.toThrow();
  });

  it('allows a new request once the cooldown has elapsed', () => {
    service.assertAllowedAndRecord('user@example.com');
    jest.advanceTimersByTime(60_001);
    expect(() => service.assertAllowedAndRecord('user@example.com')).not.toThrow();
  });

  it('caps requests per email within the abuse window, even spaced past the cooldown', () => {
    service.assertAllowedAndRecord('user@example.com');
    jest.advanceTimersByTime(60_001);
    service.assertAllowedAndRecord('user@example.com');
    jest.advanceTimersByTime(60_001);
    service.assertAllowedAndRecord('user@example.com');
    jest.advanceTimersByTime(60_001);

    expect(() => service.assertAllowedAndRecord('user@example.com')).toThrow(HttpException);
    try {
      service.assertAllowedAndRecord('user@example.com');
    } catch (error) {
      expect((error as HttpException).getResponse()).toMatchObject({
        code: 'PASSWORD_RESET_RATE_LIMITED',
      });
    }
  });

  it('resets the abuse-window cap once the window fully elapses', () => {
    service.assertAllowedAndRecord('user@example.com');
    jest.advanceTimersByTime(60_001);
    service.assertAllowedAndRecord('user@example.com');
    jest.advanceTimersByTime(60_001);
    service.assertAllowedAndRecord('user@example.com');

    jest.advanceTimersByTime(15 * 60_000 + 1);
    expect(() => service.assertAllowedAndRecord('user@example.com')).not.toThrow();
  });

  it('blocks a genuinely concurrent second call for the same email (no await between check and record)', () => {
    // Simulates two "simultaneous" requests: since assertAllowedAndRecord is
    // fully synchronous, calling it twice back-to-back with no intervening
    // await is exactly what two racing async handlers reduce to at the
    // point each of them reaches this call — there is no interleaving point
    // for a second caller to slip through between the check and the record.
    service.assertAllowedAndRecord('racer@example.com');
    expect(() => service.assertAllowedAndRecord('racer@example.com')).toThrow(HttpException);
  });
});
