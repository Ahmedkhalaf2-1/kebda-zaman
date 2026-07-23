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
});
