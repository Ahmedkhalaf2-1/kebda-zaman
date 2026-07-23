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

  it('passes with a valid DATABASE_URL and applies defaults', () => {
    const { error, value } = validationSchema.validate({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/kebda_zaman?schema=public',
    });
    expect(error).toBeUndefined();
    expect(value.API_PORT).toBe(3000);
    expect(value.NODE_ENV).toBe('development');
    expect(value.LOG_LEVEL).toBe('info');
  });
});
