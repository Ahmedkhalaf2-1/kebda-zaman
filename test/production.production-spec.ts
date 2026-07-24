import { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { validationSchema } from '../src/config/validation.schema';

function baseEnv(overrides: Record<string, string> = {}) {
  return {
    DATABASE_URL: 'postgresql://kebda:realpassword@db:5432/kebda_zaman?schema=public',
    JWT_ACCESS_SECRET: 'a-real-random-secret-that-is-at-least-32-chars-long',
    POSTGRES_PASSWORD: 'realpassword',
    ...overrides,
  };
}

describe('Production env validation (validationSchema)', () => {
  it('accepts a production env with real secrets', () => {
    const { error } = validationSchema.validate({ NODE_ENV: 'production', ...baseEnv() });
    expect(error).toBeUndefined();
  });

  it('rejects a production env whose JWT_ACCESS_SECRET is still the .env.example placeholder', () => {
    const { error } = validationSchema.validate({
      NODE_ENV: 'production',
      ...baseEnv({ JWT_ACCESS_SECRET: 'CHANGE_ME_RANDOM_SECRET_AT_LEAST_32_CHARS' }),
    });
    expect(error).toBeDefined();
    expect(error?.message).toMatch(/JWT_ACCESS_SECRET/);
  });

  it('rejects a production env whose DATABASE_URL still has the placeholder credentials', () => {
    const { error } = validationSchema.validate({
      NODE_ENV: 'production',
      ...baseEnv({
        DATABASE_URL: 'postgresql://CHANGE_ME_USER:CHANGE_ME_PASSWORD@db:5432/kebda_zaman',
      }),
    });
    expect(error).toBeDefined();
    expect(error?.message).toMatch(/DATABASE_URL/);
  });

  it('rejects a production env whose POSTGRES_PASSWORD still has the placeholder', () => {
    const { error } = validationSchema.validate({
      NODE_ENV: 'production',
      ...baseEnv({ POSTGRES_PASSWORD: 'CHANGE_ME_PASSWORD' }),
    });
    expect(error).toBeDefined();
    expect(error?.message).toMatch(/POSTGRES_PASSWORD/);
  });

  it('allows the placeholder in development/test (only production is guarded)', () => {
    const { error } = validationSchema.validate({
      NODE_ENV: 'development',
      ...baseEnv({ JWT_ACCESS_SECRET: 'CHANGE_ME_RANDOM_SECRET_AT_LEAST_32_CHARS' }),
    });
    expect(error).toBeUndefined();
  });
});

describe('AllExceptionsFilter: production error-message redaction', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  function invokeFilter(exception: unknown) {
    const filter = new AllExceptionsFilter();
    const jsonSpy = jest.fn();
    const statusSpy = jest.fn(() => ({ json: jsonSpy }));
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status: statusSpy }),
        getRequest: () => ({ url: '/api/v1/whatever', headers: {}, method: 'GET' }),
      }),
    } as unknown as ArgumentsHost;

    filter.catch(exception, host);
    return jsonSpy.mock.calls[0][0] as { message: string; statusCode: number };
  }

  it('hides the raw Error message behind a generic message in production', () => {
    process.env.NODE_ENV = 'production';
    const body = invokeFilter(new Error('ENOTFOUND internal-hostname.local: db connection failed'));
    expect(body.statusCode).toBe(500);
    expect(body.message).toBe('Internal server error');
    expect(body.message).not.toMatch(/internal-hostname/);
  });

  it('keeps the real Error message outside production for debuggability', () => {
    process.env.NODE_ENV = 'development';
    const body = invokeFilter(new Error('some internal detail'));
    expect(body.message).toBe('some internal detail');
  });

  it('never redacts a well-formed HttpException message, even in production', () => {
    process.env.NODE_ENV = 'production';
    const { NotFoundException } = jest.requireActual('@nestjs/common');
    const body = invokeFilter(
      new NotFoundException({ message: 'Order not found', code: 'ORDER_NOT_FOUND' }),
    );
    expect(body.message).toBe('Order not found');
  });
});
