import * as Joi from 'joi';

/**
 * Joi schema validating process env at boot. ConfigModule runs this on startup
 * and throws (fails fast) if a required variable is missing or malformed.
 */
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
})
  // Compose also injects POSTGRES_* vars; allow them without failing validation.
  .unknown(true);
