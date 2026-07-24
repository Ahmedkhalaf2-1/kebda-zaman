import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

// ThrottlerGuard runs before the auth guard (app.module.ts guard order), so
// these bursts don't need valid credentials to prove the per-route limit
// (plan §5.6) is enforced — each isolated app instance gets a fresh
// in-memory ThrottlerStorage so the two bursts don't interfere.
describe('Per-route rate limiting: /promos/validate, /payments/webhook (plan §5.6)', () => {
  async function freshApp(): Promise<INestApplication> {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    return app;
  }

  it('returns 429 once the per-route throttle on POST /promos/validate is exceeded', async () => {
    const app = await freshApp();
    const responses = [];
    for (let i = 0; i < 25; i += 1) {
      responses.push(
        await request(app.getHttpServer()).post('/api/v1/promos/validate').send({ code: 'X' }),
      );
    }
    expect(responses.some((r) => r.status === 429)).toBe(true);
    await app.close();
  });

  it('returns 429 once the per-route throttle on POST /payments/webhook is exceeded', async () => {
    const app = await freshApp();
    const responses = [];
    for (let i = 0; i < 25; i += 1) {
      responses.push(
        await request(app.getHttpServer())
          .post('/api/v1/payments/webhook')
          .query({ provider: 'unknown' })
          .send({}),
      );
    }
    expect(responses.some((r) => r.status === 429)).toBe(true);
    await app.close();
  });
});
