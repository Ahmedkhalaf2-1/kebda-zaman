import * as Joi from 'joi';

/**
 * Joi schema validating process env at boot. ConfigModule runs this on startup
 * and throws (fails fast) if a required variable is missing or malformed.
 */
// Secret-bearing keys checked by the production placeholder guard below.
const SECRET_ENV_KEYS = [
  'JWT_ACCESS_SECRET',
  'DATABASE_URL',
  'POSTGRES_PASSWORD',
  'MOYASAR_SECRET_KEY',
  'MOYASAR_WEBHOOK_SECRET',
  'RESEND_API_KEY',
] as const;

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  API_PORT: Joi.number().port().default(3000),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),
  CORS_ORIGINS: Joi.string().allow('').default(''),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),
  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL: Joi.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: Joi.number().integer().min(1).default(30),
  THROTTLE_TTL_SECONDS: Joi.number().integer().min(1).default(60),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(100),
  BRUTE_FORCE_MAX_ATTEMPTS: Joi.number().integer().min(1).default(5),
  BRUTE_FORCE_LOCK_MINUTES: Joi.number().integer().min(1).default(15),
  // Optional: FCM sending is disabled (safe no-op) when neither is set, so
  // local/test environments never need real Firebase credentials to boot.
  FIREBASE_PROJECT_ID: Joi.string().allow('').default('keebda-zaman'),
  FIREBASE_SERVICE_ACCOUNT_PATH: Joi.string().allow('').optional(),
  FIREBASE_SERVICE_ACCOUNT_JSON: Joi.string().allow('').optional(),
  // Directory (relative to process cwd, or absolute) where uploaded files are stored.
  UPLOAD_DIR: Joi.string().default('./uploads'),
  // Public origin used to build the imageUrl returned by the upload endpoint.
  PUBLIC_BASE_URL: Joi.string().uri().default('http://localhost:3000'),
  UPLOAD_MAX_FILE_SIZE_MB: Joi.number().integer().min(1).max(20).default(5),
  // Optional: reverse geocoding is disabled (controlled 502 on request) when unset.
  GOOGLE_GEOCODING_API_KEY: Joi.string().allow('').optional(),
  // Optional at boot (local/test never need real Google billing) — but
  // GoogleRoutesService logs at 'error' in production when this is unset
  // (see the isProduction check there, mirroring firebase-admin.provider.ts),
  // and every distance-pricing quote/checkout request fails with a
  // controlled 502 while unset.
  GOOGLE_ROUTES_API_KEY: Joi.string().allow('').optional(),
  // Optional at boot (local/test/CI never need real Moyasar credentials) —
  // MoyasarProvider logs at 'error' in production when unset, and every
  // CARD payment intent/confirm/capture/void/webhook request fails with a
  // controlled error while unset, mirroring GOOGLE_ROUTES_API_KEY above.
  MOYASAR_SECRET_KEY: Joi.string().allow('').optional(),
  MOYASAR_PUBLISHABLE_KEY: Joi.string().allow('').optional(),
  MOYASAR_WEBHOOK_SECRET: Joi.string().allow('').optional(),
  // Optional at boot (local/test/CI never need real Resend credentials) —
  // EmailService logs at 'error' in production when unset, and every
  // password-reset request still responds generically (it just can't
  // actually deliver the email), mirroring MOYASAR_SECRET_KEY above.
  RESEND_API_KEY: Joi.string().allow('').optional(),
  EMAIL_FROM: Joi.string().allow('').optional(),
  // Trusted frontend password-reset page base URL — see configuration.ts's
  // `passwordReset.url` doc comment. Optional at boot; unset just means the
  // reset email can't be built/sent yet.
  PASSWORD_RESET_URL: Joi.string().uri().allow('').optional(),
})
  // Compose also injects POSTGRES_* vars; allow them without failing validation.
  .unknown(true)
  // Fail fast if a production boot still carries a `.env.example` placeholder
  // (e.g. `.env` copied without editing) — those exact strings are public,
  // committed values and must never reach a real deployment.
  .custom((value: Record<string, unknown>, helpers) => {
    if (value.NODE_ENV !== 'production') {
      return value;
    }
    const offending = SECRET_ENV_KEYS.filter((key) => {
      const raw = value[key];
      return typeof raw === 'string' && raw.toUpperCase().includes('CHANGE_ME');
    });
    if (offending.length > 0) {
      return helpers.message({
        custom: `Refusing to start in production with placeholder secret(s) still set: ${offending.join(', ')}. Replace these with real values.`,
      });
    }
    return value;
  });
