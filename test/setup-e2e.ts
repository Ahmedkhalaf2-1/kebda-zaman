// Ensure the config validation schema is satisfied during e2e runs even when no
// real database is present. The readiness probe will still report the true DB state.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/kebda_zaman_test?schema=public';
process.env.CORS_ORIGINS ??= '';
process.env.LOG_LEVEL ??= 'silent';
