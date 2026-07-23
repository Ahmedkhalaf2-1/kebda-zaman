import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Wraps PrismaClient into the NestJS lifecycle.
 *
 * The initial connect is attempted on module init but does NOT crash the app if
 * the database is temporarily unavailable — this keeps the liveness probe green
 * while the readiness probe (which runs an actual query) reports the real state.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('Prisma connected to the database');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Prisma could not connect on startup (will retry lazily on first query): ${message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Lightweight connectivity probe used by the readiness health check. */
  async pingDatabase(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
