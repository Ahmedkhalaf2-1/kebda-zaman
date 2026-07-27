import * as Joi from 'joi';

/**
 * Joi schema validating process env at boot. ConfigModule runs this on startup
 * and throws (fails fast) if a required variable is missing or malformed.
 */
// Secret-bearing keys checked by the production placeholder guard below.
const SECRET_ENV_KEYS = ['JWT_ACCESS_SECRET', 'DATABASE_URL', 'POSTGRES_PASSWORD'] as const;

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
