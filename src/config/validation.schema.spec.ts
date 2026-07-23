import { validationSchema } from './validation.schema';

describe('config validation schema (fail-fast)', () => {
  it('fails when DATABASE_URL is missing', () => {
    const { error } = validationSchema.validate({ NODE_ENV: 'test' }, { abortEarly: false });
    expect(error).toBeDefined();
    expect(error?.message).toContain('DATABASE_URL');
  });

  it('fails when DATABASE_URL is not a postgres URI', () => {
    const { error } = validationSchema.validate({ DATABASE_URL: 'not-a-valid-url' });
    expect(error).toBeDefined();
  });

  it('fails when NODE_ENV is not an allowed value', () => {
    const { error } = validationSchema.validate({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      NODE_ENV: 'staging',
    });
    expect(error).toBeDefined();
  });

  it('fails when JWT_ACCESS_SECRET is missing', () => {
    const { error } = validationSchema.validate({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/kebda_zaman?schema=public',
    });
    expect(error).toBeDefined();
    expect(error?.message).toContain('JWT_ACCESS_SECRET');
  });

  it('fails when JWT_ACCESS_SECRET is shorter than 32 characters', () => {
    const { error } = validationSchema.validate({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/kebda_zaman?schema=public',
      JWT_ACCESS_SECRET: 'too-short',
    });
    expect(error).toBeDefined();
  });

  it('passes with a valid DATABASE_URL and JWT_ACCESS_SECRET, applying defaults', () => {
    const { error, value } = validationSchema.validate({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/kebda_zaman?schema=public',
      JWT_ACCESS_SECRET: 'a'.repeat(32),
    });
    expect(error).toBeUndefined();
    expect(value.API_PORT).toBe(3000);
    expect(value.NODE_ENV).toBe('development');
    expect(value.LOG_LEVEL).toBe('info');
    expect(value.JWT_ACCESS_TTL).toBe('15m');
    expect(value.JWT_REFRESH_TTL_DAYS).toBe(30);
    expect(value.THROTTLE_LIMIT).toBe(100);
    expect(value.BRUTE_FORCE_MAX_ATTEMPTS).toBe(5);
  });
});
