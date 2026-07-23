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
})
  // Compose also injects POSTGRES_* vars; allow them without failing validation.
  .unknown(true);
