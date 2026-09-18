import { resolve } from 'node:path';

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
  firebase: {
    projectId: string;
    // At most one of these is normally set; when neither is, FCM sending is
    // disabled (safe no-op) rather than the app failing to boot — required
    // for local/test environments with no Firebase credentials configured.
    serviceAccountPath?: string;
    serviceAccountJson?: string;
  };
  uploads: {
    // Absolute path on disk where uploaded files are written/served from.
    dir: string;
    // Origin used to build the public imageUrl returned to clients (scheme+host+port).
    publicBaseUrl: string;
    maxFileSizeMb: number;
  };
  googleGeocoding: {
    // Server-side only — never exposed to Flutter. Unset disables the
    // reverse-geocode endpoint (it fails with a controlled 502).
    apiKey?: string;
  };
  googleRoutes: {
    // Server-side only — never exposed to Flutter, never logged. Unset
    // disables distance-based delivery pricing (quote/checkout both fail
    // with a controlled 502) — see GoogleRoutesService.
    apiKey?: string;
  };
  moyasar: {
    // Backend-only — used for Basic Auth against api.moyasar.com. Never
    // exposed to Flutter, never logged, never returned in any API response.
    secretKey?: string;
    // Safe to expose to Flutter (it's designed for client-side use) —
    // returned from the payments/intent endpoint, never used server-side.
    publishableKey?: string;
    // Compared against the `secret_token` field inside each webhook payload
    // body (Moyasar puts the shared secret in the JSON body, not a header).
    webhookSecret?: string;
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
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID ?? 'keebda-zaman',
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || undefined,
    serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || undefined,
  },
  uploads: {
    dir: resolve(process.cwd(), process.env.UPLOAD_DIR ?? './uploads'),
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    maxFileSizeMb: parseInt(process.env.UPLOAD_MAX_FILE_SIZE_MB ?? '5', 10),
  },
  googleGeocoding: {
    apiKey: process.env.GOOGLE_GEOCODING_API_KEY || undefined,
  },
  googleRoutes: {
    apiKey: process.env.GOOGLE_ROUTES_API_KEY || undefined,
  },
  moyasar: {
    secretKey: process.env.MOYASAR_SECRET_KEY || undefined,
    publishableKey: process.env.MOYASAR_PUBLISHABLE_KEY || undefined,
    webhookSecret: process.env.MOYASAR_WEBHOOK_SECRET || undefined,
  },
});
