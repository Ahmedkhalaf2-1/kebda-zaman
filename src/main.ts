import 'reflect-metadata';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { buildCorsOptions } from './config/cors.config';
import { STATIC_UPLOADS_PREFIX } from './modules/uploads/uploads.constants';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

  // Route Nest's internal logs through the structured pino logger.
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);

  // All routes served under /api/v1 (URI versioning).
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Security headers. Cross-origin resource policy is relaxed so uploaded
  // images (served statically below) can be embedded by the allowed CORS
  // origins — the default `same-origin` policy would otherwise block <img>
  // loads from the separate web admin/mobile origins this API is built for.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  // CORS: production frontend origins come from env (explicit allowlist, no
  // wildcards); local Flutter Web dev origins (http://localhost:<any port>,
  // http://127.0.0.1:<any port>) are always allowed — see cors.config.ts.
  const corsOrigins = config.get<string[]>('corsOrigins') ?? [];
  app.enableCors(buildCorsOptions(corsOrigins));

  // Serves uploaded files as plain static assets at /uploads/<filename> —
  // intentionally outside the /api/v1 prefix (not a versioned API resource).
  app.useStaticAssets(config.get<string>('uploads.dir')!, { prefix: STATIC_UPLOADS_PREFIX });

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
