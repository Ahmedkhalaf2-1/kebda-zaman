import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { PrismaHealthIndicator } from './prisma.health';

/**
 * Health endpoints (served under the global prefix + version => /api/v1/health).
 *
 *  - GET /api/v1/health        Liveness: the process is up. No external deps.
 *  - GET /api/v1/health/ready  Readiness: includes a real PostgreSQL ping.
 */
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  liveness() {
    // No indicators => reports { status: 'ok' } as long as the process serves requests.
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([() => this.prismaIndicator.isHealthy('database')]);
  }
}
