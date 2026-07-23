import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Phase 0 e2e: proves the application boots and the liveness endpoint responds
 * under the /api/v1 prefix. Liveness intentionally does not depend on the DB,
 * so this runs in CI without a database. Readiness/DB connectivity is verified
 * against a live PostgreSQL via docker-compose.
 */
describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health returns 200 with status ok (liveness)', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('GET /api/v1/health/ready is reachable and returns a health-check body', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health/ready');
    // 200 when the DB is up, 503 when it is not — both are valid Terminus responses.
    expect([200, 503]).toContain(response.status);
    expect(response.body).toHaveProperty('status');
    expect(response.body).toHaveProperty('details');
    expect(response.body.details).toHaveProperty('database');
  });
});
