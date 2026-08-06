import { INestApplication, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { buildCorsOptions } from '../src/config/cors.config';

/**
 * Regression test for the Flutter Web preflight bug: passing `origin: false`
 * to the `cors` package (the old behavior when CORS_ORIGINS was unset) made
 * it skip its OPTIONS-handling branch entirely, so preflights fell through
 * to the router and 404'd before the browser ever sent the real request.
 * These tests exercise main.ts's actual CORS setup end-to-end.
 */
describe('CORS (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    // Same allowlist shape as production with no CORS_ORIGINS set — this is
    // exactly the configuration that used to 404 on preflight.
    app.enableCors(buildCorsOptions([]));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers an OPTIONS preflight for a Flutter Web dev origin with a matching Access-Control-Allow-Origin', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/v1/auth/login')
      .set('Origin', 'http://localhost:52599')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect([200, 204]).toContain(response.status);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:52599');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-headers']?.toLowerCase()).toContain(
      'content-type',
    );
  });

  it('reflects a 127.0.0.1 dev origin on any port', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/v1/auth/login')
      .set('Origin', 'http://127.0.0.1:61234')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect([200, 204]).toContain(response.status);
    expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:61234');
  });

  it('does not set Access-Control-Allow-Origin for an origin outside the dev/allowlist set', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/v1/auth/login')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
