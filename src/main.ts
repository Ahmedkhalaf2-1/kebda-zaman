import 'reflect-metadata';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Route Nest's internal logs through the structured pino logger.
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);

  // All routes served under /api/v1 (URI versioning).
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Security headers.
  app.use(helmet());

  // CORS entirely from env — explicit origin allowlist, no wildcards.
  const corsOrigins = config.get<string[]>('corsOrigins') ?? [];
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Global request validation.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Canonical error envelope for every unhandled/HTTP exception.
  app.useGlobalFilters(new AllExceptionsFilter());

  // Graceful shutdown (drives Prisma onModuleDestroy).
  app.enableShutdownHooks();

  const port = config.get<number>('port') ?? 3000;
  // Bind 0.0.0.0 so the API is reachable from the host, emulator, LAN and VPS.
  await app.listen(port, '0.0.0.0');

  app.get(Logger).log(`Kebda Zaman API listening on port ${port} (base path /api/v1)`);
}

void bootstrap();
