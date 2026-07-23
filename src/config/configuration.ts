/**
 * Typed application configuration, loaded from validated environment variables.
 * Nothing here reads a hardcoded host/IP/secret — every value comes from the env.
 */
export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  logLevel: string;
  corsOrigins: string[];
  databaseUrl: string;
  jwt: {
    accessSecret: string;
    accessTtl: string;
    refreshTtlDays: number;
  };
  throttle: {
    ttlSeconds: number;
    limit: number;
  };
  bruteForce: {
    maxAttempts: number;
    lockMinutes: number;
  };
}

export default (): AppConfig => ({
  nodeEnv: (process.env.NODE_ENV as AppConfig['nodeEnv']) ?? 'development',
  port: parseInt(process.env.API_PORT ?? '3000', 10),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? '',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtlDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS ?? '30', 10),
  },
  throttle: {
    ttlSeconds: parseInt(process.env.THROTTLE_TTL_SECONDS ?? '60', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
  },
  bruteForce: {
    maxAttempts: parseInt(process.env.BRUTE_FORCE_MAX_ATTEMPTS ?? '5', 10),
    lockMinutes: parseInt(process.env.BRUTE_FORCE_LOCK_MINUTES ?? '15', 10),
  },
});
