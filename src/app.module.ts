import { randomUUID } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import configuration from './config/configuration';
import { validationSchema } from './config/validation.schema';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    // Typed + validated configuration. Fails fast on a missing/invalid env var.
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validationSchema,
      validationOptions: { abortEarly: false },
    }),

    // Structured JSON logging with per-request correlation ids.
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isProduction = config.get<string>('nodeEnv') === 'production';
        return {
          pinoHttp: {
            level: config.get<string>('logLevel') ?? 'info',
            // Correlation id: reuse an inbound x-request-id or generate one.
            genReqId: (req: IncomingMessage, res) => {
              const existing = req.headers['x-request-id'];
              const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
              res.setHeader('x-request-id', id);
              return id;
            },
            autoLogging: true,
            // Pretty logs in dev, raw JSON in production.
            transport: isProduction
              ? undefined
              : {
                  target: 'pino-pretty',
                  options: { singleLine: true, translateTime: 'SYS:standard' },
                },
            redact: {
              paths: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password'],
              remove: true,
            },
          },
        };
      },
    }),

    PrismaModule,
    HealthModule,
  ],
})
export class AppModule {}
