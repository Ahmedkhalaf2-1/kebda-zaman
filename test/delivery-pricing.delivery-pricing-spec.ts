import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  GatewayTimeoutException,
  INestApplication,
  ServiceUnavailableException,
  UnprocessableEntityException,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { AuthService } from '../src/modules/auth/auth.service';
import { GoogleRoutesService } from '../src/modules/delivery-pricing/google-routes.service';

/** VO3: POST /api/v1/delivery/quote + admin distance-tier smoke coverage.
 * Automated tests never call the real Google API — GoogleRoutesService is
 * always overridden with this mock. */
const mockGoogleRoutesService = {
  computeRoute: jest.fn().mockResolvedValue({ distanceMeters: 5_000, durationSeconds: 600 }),
};

const DESTINATION = { latitude: 21.6, longitude: 39.2 };

/** The quote endpoint caches by rounded coordinates for 60s (by design —
 * see DeliveryPricingService.getCachedQuote) — each test that expects a
 * specific mocked Google response needs its own destination so it can never
 * read back another test's cached result. */
let destinationCounter = 0;
function uniqueDestination() {
  destinationCounter += 1;
  return {
    latitude: 21.6 + destinationCounter * 0.01,
    longitude: 39.2 + destinationCounter * 0.01,
  };
}

describe('Delivery Quote & Admin Distance Tiers (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;
  const cleanupUserIds: string[] = [];

  async function registerCustomer() {
    const registered = await authService.register(
      {
        name: 'DP Customer',
        email: `dp-customer-${randomUUID()}@vo3.local`,
        password: 'correcthorsebattery',
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    return registered;
  }

  async function registerAdmin() {
    const registered = await authService.register(
      {
        name: 'DP Admin',
        email: `dp-admin-${randomUUID()}@vo3.local`,
        password: 'correcthorsebattery',
      },
      {},
    );
    cleanupUserIds.push(registered.user.id);
    await prisma.user.update({
      where: { id: registered.user.id },
      data: { role: 'ADMIN' as UserRole },
    });
    return authService.login(
      { email: registered.user.email as string, password: 'correcthorsebattery' },
      {},
    );
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GoogleRoutesService)
      .useValue(mockGoogleRoutesService)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    authService = app.get(AuthService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    await app.close();
  });

  beforeEach(() => {
    mockGoogleRoutesService.computeRoute.mockReset();
    mockGoogleRoutesService.computeRoute.mockResolvedValue({
      distanceMeters: 5_000,
      durationSeconds: 600,
    });
  });

  // ===========================================================================
  describe('POST /delivery/quote', () => {
    it('rejects an unauthenticated caller with 401', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/delivery/quote')
        .send(uniqueDestination());
      expect(res.status).toBe(401);
    });

    it('returns a deliverable quote with fee/tier for a destination inside range', async () => {
      const { accessToken } = await registerCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/delivery/quote')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(uniqueDestination());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        deliverable: true,
        distanceMeters: 5_000,
        distanceKm: '5.00',
        durationSeconds: 600,
        durationMinutes: 10,
        deliveryFee: '10.00',
        minimumOrder: '0.00',
        tier: { minDistanceKm: '0.00', maxDistanceKm: '15.00' },
      });
      expect(res.body.currency).toEqual(expect.any(String));
    });

    it('returns deliverable: false with OUTSIDE_DELIVERY_RANGE beyond 30km — never a 4xx/5xx', async () => {
      mockGoogleRoutesService.computeRoute.mockResolvedValue({
        distanceMeters: 30_500,
        durationSeconds: 2400,
      });
      const { accessToken } = await registerCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/delivery/quote')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(uniqueDestination());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        deliverable: false,
        distanceMeters: 30_500,
        distanceKm: '30.50',
        reason: 'OUTSIDE_DELIVERY_RANGE',
      });
      expect(res.body.deliveryFee).toBeNull();
      expect(res.body.tier).toBeNull();
    });

    it('never exposes the Google API key in the response', async () => {
      const { accessToken } = await registerCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/delivery/quote')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(uniqueDestination());
      expect(JSON.stringify(res.body)).not.toMatch(/key/i);
    });

    it('rejects an invalid latitude with 400', async () => {
      const { accessToken } = await registerCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/delivery/quote')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ latitude: 999, longitude: 39.2 });
      expect(res.status).toBe(400);
    });

    it('rejects an invalid longitude with 400', async () => {
      const { accessToken } = await registerCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/delivery/quote')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ latitude: 21.6, longitude: -999 });
      expect(res.status).toBe(400);
    });

    it('does not let the client select travel mode or supply an origin (unknown fields rejected)', async () => {
      const { accessToken } = await registerCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/delivery/quote')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...DESTINATION, travelMode: 'WALK', originLatitude: 1, originLongitude: 1 });
      expect(res.status).toBe(400);
    });

    it('propagates "no route found" as a controlled 422', async () => {
      mockGoogleRoutesService.computeRoute.mockRejectedValue(
        new UnprocessableEntityException({
          message: 'No drivable route was found for the given coordinates',
          code: 'ROUTES_NO_ROUTE_FOUND',
        }),
      );
      const { accessToken } = await registerCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/delivery/quote')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(uniqueDestination());
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('ROUTES_NO_ROUTE_FOUND');
    });

    it('propagates a Google Routes timeout as a controlled 504', async () => {
      mockGoogleRoutesService.computeRoute.mockRejectedValue(
        new GatewayTimeoutException({
          message: 'Delivery distance provider did not respond in time',
          code: 'ROUTES_TIMEOUT',
        }),
      );
      const { accessToken } = await registerCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/delivery/quote')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(uniqueDestination());
      expect(res.status).toBe(504);
      expect(res.body.code).toBe('ROUTES_TIMEOUT');
    });

    it('propagates a Google Routes quota/permission failure as a controlled 5xx, never a silent fallback', async () => {
      mockGoogleRoutesService.computeRoute.mockRejectedValue(
        new ServiceUnavailableException({
          message: 'Delivery distance pricing is temporarily unavailable',
          code: 'ROUTES_QUOTA_EXCEEDED',
        }),
      );
      const { accessToken } = await registerCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/delivery/quote')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(uniqueDestination());
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('ROUTES_QUOTA_EXCEEDED');
    });

    it('propagates an unconfigured/denied provider as a controlled 502', async () => {
      mockGoogleRoutesService.computeRoute.mockRejectedValue(
        new BadGatewayException({
          message: 'Delivery distance provider rejected the request',
          code: 'ROUTES_PROVIDER_CONFIG_ERROR',
        }),
      );
      const { accessToken } = await registerCustomer();
      const res = await request(app.getHttpServer())
        .post('/api/v1/delivery/quote')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(uniqueDestination());
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('ROUTES_PROVIDER_CONFIG_ERROR');
    });
  });

  // ===========================================================================
  describe('Admin distance tiers — smoke coverage (full CRUD/validation is in restaurant-settings-spec)', () => {
    it('ADMIN sees the 3 approved production tiers seeded by the migration', async () => {
      const admin = await registerAdmin();
      const res = await request(app.getHttpServer())
        .get('/api/v1/admin/delivery-tiers')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(res.status).toBe(200);
      const active = res.body.filter((t: { isActive: boolean }) => t.isActive);
      expect(active).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            minDistanceKm: '0.00',
            maxDistanceKm: '15.00',
            deliveryFee: '10.00',
          }),
          expect.objectContaining({
            minDistanceKm: '15.00',
            maxDistanceKm: '25.00',
            deliveryFee: '15.00',
          }),
          expect.objectContaining({
            minDistanceKm: '25.00',
            maxDistanceKm: '30.00',
            deliveryFee: '25.00',
          }),
        ]),
      );
    });

    it('rejects an unauthenticated caller with 401', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/admin/delivery-tiers');
      expect(res.status).toBe(401);
    });
  });
});
