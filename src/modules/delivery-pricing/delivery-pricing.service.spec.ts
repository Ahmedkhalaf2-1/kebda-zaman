import { Prisma } from '@prisma/client';
import {
  DeliveryPricingService,
  matchDistanceTier,
  validateActiveTierCoverage,
} from './delivery-pricing.service';
import { GoogleRoutesService } from './google-routes.service';
import { PrismaService } from '../../prisma/prisma.service';

const D = (v: string | number) => new Prisma.Decimal(v);

/** The 3 approved production tiers (mirrors the migration's seed data). */
function approvedTiers() {
  return [
    {
      id: 'tier-1',
      minDistanceKm: D('0.00'),
      maxDistanceKm: D('15.00'),
      deliveryFee: D('10.00'),
      minimumOrder: D('0.00'),
    },
    {
      id: 'tier-2',
      minDistanceKm: D('15.00'),
      maxDistanceKm: D('25.00'),
      deliveryFee: D('15.00'),
      minimumOrder: D('0.00'),
    },
    {
      id: 'tier-3',
      minDistanceKm: D('25.00'),
      maxDistanceKm: D('30.00'),
      deliveryFee: D('25.00'),
      minimumOrder: D('0.00'),
    },
  ];
}

describe('matchDistanceTier — boundary behavior against the 3 approved tiers', () => {
  const tiers = approvedTiers();

  it.each([
    [0, 'tier-1'],
    [14_999, 'tier-1'],
    [15_000, 'tier-2'],
    [24_999, 'tier-2'],
    [25_000, 'tier-3'],
    [30_000, 'tier-3'],
    [30_001, null],
  ])('%i meters -> %s', (distanceMeters, expectedId) => {
    const match = matchDistanceTier(tiers, distanceMeters);
    expect(match?.id ?? null).toBe(expectedId);
  });
});

describe('validateActiveTierCoverage', () => {
  const km = (v: number) => v * 1000;

  it('accepts the 3 approved tiers (contiguous, one final tier)', () => {
    expect(() =>
      validateActiveTierCoverage([
        { minMeters: km(0), maxMeters: km(15) },
        { minMeters: km(15), maxMeters: km(25) },
        { minMeters: km(25), maxMeters: km(30) },
      ]),
    ).not.toThrow();
  });

  it('rejects an overlapping pair', () => {
    expect(() =>
      validateActiveTierCoverage([
        { minMeters: km(0), maxMeters: km(15) },
        { minMeters: km(10), maxMeters: km(25) },
      ]),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'DELIVERY_TIER_OVERLAP' }),
      }),
    );
  });

  it('rejects a coverage gap', () => {
    expect(() =>
      validateActiveTierCoverage([
        { minMeters: km(0), maxMeters: km(10) },
        { minMeters: km(15), maxMeters: km(30) },
      ]),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'DELIVERY_TIER_COVERAGE_GAP' }),
      }),
    );
  });

  it('rejects coverage that does not start at 0km', () => {
    expect(() => validateActiveTierCoverage([{ minMeters: km(5), maxMeters: km(30) }])).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'DELIVERY_TIER_COVERAGE_GAP' }),
      }),
    );
  });

  it('rejects two tiers both claiming the final (highest-max) boundary', () => {
    expect(() =>
      validateActiveTierCoverage([
        { minMeters: km(0), maxMeters: km(30) },
        { minMeters: km(0), maxMeters: km(30) },
      ]),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'DELIVERY_TIER_AMBIGUOUS_FINAL' }),
      }),
    );
  });

  it('rejects an inverted range (max <= min)', () => {
    expect(() => validateActiveTierCoverage([{ minMeters: km(10), maxMeters: km(5) }])).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'DELIVERY_TIER_INVALID_RANGE' }),
      }),
    );
  });
});

describe('DeliveryPricingService.getAuthoritativeQuote / getCachedQuote', () => {
  const settings = {
    singleton: true,
    restaurantLatitude: D('21.5705641'),
    restaurantLongitude: D('39.1681808'),
    currency: 'SAR',
  };

  let prisma: {
    restaurantSettings: { findFirstOrThrow: jest.Mock };
    deliveryDistanceTier: { findMany: jest.Mock };
  };
  let googleRoutes: { computeRoute: jest.Mock };
  let service: DeliveryPricingService;

  beforeEach(() => {
    prisma = {
      restaurantSettings: { findFirstOrThrow: jest.fn().mockResolvedValue(settings) },
      deliveryDistanceTier: { findMany: jest.fn().mockResolvedValue(approvedTiers()) },
    };
    googleRoutes = { computeRoute: jest.fn() };
    service = new DeliveryPricingService(
      prisma as unknown as PrismaService,
      googleRoutes as unknown as GoogleRoutesService,
    );
  });

  it('resolves a deliverable quote inside the first tier', async () => {
    googleRoutes.computeRoute.mockResolvedValue({ distanceMeters: 5_000, durationSeconds: 600 });

    const result = await service.getAuthoritativeQuote({ latitude: 1, longitude: 1 });

    expect(result.deliverable).toBe(true);
    expect(result.tier?.id).toBe('tier-1');
    expect(googleRoutes.computeRoute).toHaveBeenCalledWith(
      { latitude: 21.5705641, longitude: 39.1681808 },
      { latitude: 1, longitude: 1 },
    );
  });

  it('reports OUTSIDE_DELIVERY_RANGE beyond the final tier without throwing', async () => {
    googleRoutes.computeRoute.mockResolvedValue({ distanceMeters: 30_001, durationSeconds: 3000 });

    const result = await service.getAuthoritativeQuote({ latitude: 1, longitude: 1 });

    expect(result.deliverable).toBe(false);
    expect(result.tier).toBeNull();
    expect(result.reason).toBe('OUTSIDE_DELIVERY_RANGE');
  });

  it('fails with a controlled error when restaurant coordinates are missing/invalid, never calling Google', async () => {
    prisma.restaurantSettings.findFirstOrThrow.mockResolvedValue({
      ...settings,
      restaurantLatitude: D('999'),
    });

    await expect(
      service.getAuthoritativeQuote({ latitude: 1, longitude: 1 }),
    ).rejects.toMatchObject({
      response: { code: 'RESTAURANT_LOCATION_NOT_CONFIGURED' },
    });
    expect(googleRoutes.computeRoute).not.toHaveBeenCalled();
  });

  it('never trusts a client-supplied fee/distance/tier — always recomputes from Google + DB', async () => {
    googleRoutes.computeRoute.mockResolvedValue({ distanceMeters: 20_000, durationSeconds: 1200 });

    const result = await service.getAuthoritativeQuote({ latitude: 1, longitude: 1 });

    expect(result.tier?.id).toBe('tier-2');
    expect(result.tier?.deliveryFee.toString()).toBe('15');
  });

  it('caches a quote result for repeated identical coordinates (quote endpoint only)', async () => {
    googleRoutes.computeRoute.mockResolvedValue({ distanceMeters: 5_000, durationSeconds: 600 });

    await service.getCachedQuote({ latitude: 1.23456, longitude: 4.56789 });
    await service.getCachedQuote({ latitude: 1.23456, longitude: 4.56789 });

    expect(googleRoutes.computeRoute).toHaveBeenCalledTimes(1);
  });

  it('never caches a thrown failure', async () => {
    googleRoutes.computeRoute.mockRejectedValueOnce(new Error('boom'));
    googleRoutes.computeRoute.mockResolvedValueOnce({
      distanceMeters: 5_000,
      durationSeconds: 600,
    });

    await expect(service.getCachedQuote({ latitude: 9.1, longitude: 9.2 })).rejects.toThrow('boom');
    const result = await service.getCachedQuote({ latitude: 9.1, longitude: 9.2 });

    expect(result.deliverable).toBe(true);
    expect(googleRoutes.computeRoute).toHaveBeenCalledTimes(2);
  });

  it('getAuthoritativeQuote never reads or writes the quote cache (always live)', async () => {
    googleRoutes.computeRoute.mockResolvedValue({ distanceMeters: 5_000, durationSeconds: 600 });

    await service.getCachedQuote({ latitude: 2, longitude: 2 });
    await service.getAuthoritativeQuote({ latitude: 2, longitude: 2 });

    expect(googleRoutes.computeRoute).toHaveBeenCalledTimes(2);
  });
});
