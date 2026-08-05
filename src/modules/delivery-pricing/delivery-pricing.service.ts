import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DeliveryDistanceTier, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { GoogleRoutesService, LatLng } from './google-routes.service';
import { DeliveryDistanceTierDto } from './dto/delivery-distance-tier.dto';

export type DeliveryUnavailableReason = 'OUTSIDE_DELIVERY_RANGE';

export interface DeliveryQuoteResult {
  deliverable: boolean;
  distanceMeters: number;
  durationSeconds: number;
  currency: string;
  /** The matched tier row (Decimal fields intact) — present iff deliverable. */
  tier: DeliveryDistanceTier | null;
  reason?: DeliveryUnavailableReason;
}

/** Km bounds normalized to whole meters, for boundary-safe comparisons. */
interface TierMeterRange {
  minMeters: number;
  maxMeters: number;
}

const QUOTE_CACHE_TTL_MS = 60_000;
/** Rounds a coordinate to ~11m precision for cache-key purposes only — never used for pricing math. */
const CACHE_COORD_PRECISION = 4;

function toMeters(km: Prisma.Decimal | number): number {
  return Math.round(Number(km) * 1000);
}

/**
 * Converts a set of tiers (candidate + siblings, as plain km numbers) to
 * meter ranges and matches `distanceMeters` against them. The tier with the
 * greatest `maxDistanceKm` is inclusive on its max; every other tier is
 * exclusive on its max — see the schema doc comment on DeliveryDistanceTier.
 * Pure/exported so boundary behavior is directly unit-testable without a DB.
 */
export function matchDistanceTier<
  T extends { minDistanceKm: Prisma.Decimal; maxDistanceKm: Prisma.Decimal },
>(tiers: T[], distanceMeters: number): T | null {
  if (tiers.length === 0) {
    return null;
  }
  const finalTier = tiers.reduce((max, tier) =>
    tier.maxDistanceKm.greaterThan(max.maxDistanceKm) ? tier : max,
  );
  for (const tier of tiers) {
    const minMeters = toMeters(tier.minDistanceKm);
    const maxMeters = toMeters(tier.maxDistanceKm);
    const isFinal = tier === finalTier;
    if (
      distanceMeters >= minMeters &&
      (isFinal ? distanceMeters <= maxMeters : distanceMeters < maxMeters)
    ) {
      return tier;
    }
  }
  return null;
}

/**
 * Validates that a set of active tier ranges (candidate included) forms
 * continuous, non-overlapping coverage starting at 0km, with exactly one
 * unambiguous "final" (highest-max) tier. Throws UnprocessableEntityException
 * with a specific `code` on the first violation found. Pure/exported for
 * direct unit testing.
 */
export function validateActiveTierCoverage(ranges: TierMeterRange[]): void {
  if (ranges.length === 0) {
    return;
  }
  const sorted = [...ranges].sort((a, b) => a.minMeters - b.minMeters);

  for (const range of sorted) {
    if (range.maxMeters <= range.minMeters) {
      throw new UnprocessableEntityException({
        message: "A tier's maxDistanceKm must be greater than its minDistanceKm",
        code: 'DELIVERY_TIER_INVALID_RANGE',
      });
    }
  }

  const maxOfAll = Math.max(...sorted.map((r) => r.maxMeters));
  const finalTiers = sorted.filter((r) => r.maxMeters === maxOfAll);
  if (finalTiers.length > 1) {
    throw new UnprocessableEntityException({
      message: 'More than one active tier claims the final (highest) distance boundary',
      code: 'DELIVERY_TIER_AMBIGUOUS_FINAL',
    });
  }

  if (sorted[0].minMeters !== 0) {
    throw new UnprocessableEntityException({
      message: 'Active tiers must start coverage at 0km with no gap',
      code: 'DELIVERY_TIER_COVERAGE_GAP',
    });
  }

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];
    const currentIsFinal = current.maxMeters === maxOfAll;
    const currentEffectiveEnd = currentIsFinal ? current.maxMeters + 1 : current.maxMeters;
    if (next.minMeters < currentEffectiveEnd) {
      throw new UnprocessableEntityException({
        message: 'Active delivery tiers overlap',
        code: 'DELIVERY_TIER_OVERLAP',
      });
    }
    if (next.minMeters > currentEffectiveEnd) {
      throw new UnprocessableEntityException({
        message: 'Active delivery tiers leave a coverage gap',
        code: 'DELIVERY_TIER_COVERAGE_GAP',
      });
    }
  }
}

@Injectable()
export class DeliveryPricingService {
  private readonly logger = new Logger(DeliveryPricingService.name);
  private readonly quoteCache = new Map<
    string,
    { expiresAt: number; value: DeliveryQuoteResult }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly googleRoutes: GoogleRoutesService,
  ) {}

  // ===========================================================================
  // Admin CRUD
  // ===========================================================================

  async adminList(): Promise<DeliveryDistanceTier[]> {
    return this.prisma.deliveryDistanceTier.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(dto: DeliveryDistanceTierDto): Promise<DeliveryDistanceTier> {
    const isActive = dto.isActive ?? true;
    if (isActive) {
      await this.assertValidCoverage(dto, null);
    } else {
      this.assertValidRange(dto);
    }

    return this.prisma.deliveryDistanceTier.create({
      data: {
        minDistanceKm: dto.minDistanceKm,
        maxDistanceKm: dto.maxDistanceKm,
        deliveryFee: dto.deliveryFee,
        minimumOrder: dto.minimumOrder ?? 0,
        isActive,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async update(id: string, dto: DeliveryDistanceTierDto): Promise<DeliveryDistanceTier> {
    const existing = await this.findOrThrow(id);
    const isActive = dto.isActive ?? existing.isActive;
    if (isActive) {
      await this.assertValidCoverage(dto, id);
    } else {
      this.assertValidRange(dto);
    }

    return this.prisma.deliveryDistanceTier.update({
      where: { id: existing.id },
      data: {
        minDistanceKm: dto.minDistanceKm,
        maxDistanceKm: dto.maxDistanceKm,
        deliveryFee: dto.deliveryFee,
        minimumOrder: dto.minimumOrder ?? existing.minimumOrder,
        isActive,
        sortOrder: dto.sortOrder ?? existing.sortOrder,
      },
    });
  }

  private async findOrThrow(id: string): Promise<DeliveryDistanceTier> {
    const tier = await this.prisma.deliveryDistanceTier.findUnique({ where: { id } });
    if (!tier) {
      throw new NotFoundException({
        message: 'Delivery tier not found',
        code: 'DELIVERY_TIER_NOT_FOUND',
      });
    }
    return tier;
  }

  private assertValidRange(dto: DeliveryDistanceTierDto): void {
    if (dto.maxDistanceKm <= dto.minDistanceKm) {
      throw new UnprocessableEntityException({
        message: 'maxDistanceKm must be greater than minDistanceKm',
        code: 'DELIVERY_TIER_INVALID_RANGE',
      });
    }
  }

  /** Validates the candidate against every OTHER currently-active tier (excluding `excludeId` on update). */
  private async assertValidCoverage(
    dto: DeliveryDistanceTierDto,
    excludeId: string | null,
  ): Promise<void> {
    this.assertValidRange(dto);

    const otherActive = await this.prisma.deliveryDistanceTier.findMany({
      where: { isActive: true, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });

    const ranges: TierMeterRange[] = [
      ...otherActive.map((tier) => ({
        minMeters: toMeters(tier.minDistanceKm),
        maxMeters: toMeters(tier.maxDistanceKm),
      })),
      { minMeters: toMeters(dto.minDistanceKm), maxMeters: toMeters(dto.maxDistanceKm) },
    ];

    validateActiveTierCoverage(ranges);
  }

  // ===========================================================================
  // Pricing
  // ===========================================================================

  async getActiveTiersSorted(): Promise<DeliveryDistanceTier[]> {
    return this.prisma.deliveryDistanceTier.findMany({
      where: { isActive: true },
      orderBy: { minDistanceKm: 'asc' },
    });
  }

  /** Authoritative, always-live calculation — used only by checkout. Never cached. */
  async getAuthoritativeQuote(destination: LatLng): Promise<DeliveryQuoteResult> {
    return this.computeQuote(destination);
  }

  /** Cached (short TTL) calculation for the public quote endpoint. Never used by checkout. */
  async getCachedQuote(destination: LatLng): Promise<DeliveryQuoteResult> {
    const key = this.cacheKey(destination);
    const cached = this.quoteCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const result = await this.computeQuote(destination);
    // Failures throw before reaching here — a thrown quote is never cached.
    this.quoteCache.set(key, { expiresAt: Date.now() + QUOTE_CACHE_TTL_MS, value: result });
    return result;
  }

  private async computeQuote(destination: LatLng): Promise<DeliveryQuoteResult> {
    const settings = await this.prisma.restaurantSettings.findFirstOrThrow({
      where: { singleton: true },
    });
    const origin = this.resolveOrigin(settings.restaurantLatitude, settings.restaurantLongitude);

    const { distanceMeters, durationSeconds } = await this.googleRoutes.computeRoute(
      origin,
      destination,
    );
    const activeTiers = await this.getActiveTiersSorted();
    const tier = matchDistanceTier(activeTiers, distanceMeters);

    if (!tier) {
      return {
        deliverable: false,
        distanceMeters,
        durationSeconds,
        currency: settings.currency,
        tier: null,
        reason: 'OUTSIDE_DELIVERY_RANGE',
      };
    }

    return {
      deliverable: true,
      distanceMeters,
      durationSeconds,
      currency: settings.currency,
      tier,
    };
  }

  private resolveOrigin(latitude: Prisma.Decimal, longitude: Prisma.Decimal): LatLng {
    const lat = latitude.toNumber();
    const lng = longitude.toNumber();
    if (
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90 ||
      !Number.isFinite(lng) ||
      lng < -180 ||
      lng > 180
    ) {
      this.logger.error('RestaurantSettings coordinates are missing or out of range');
      throw new UnprocessableEntityException({
        message: 'The restaurant location is not configured correctly',
        code: 'RESTAURANT_LOCATION_NOT_CONFIGURED',
      });
    }
    return { latitude: lat, longitude: lng };
  }

  private cacheKey(destination: LatLng): string {
    return `${destination.latitude.toFixed(CACHE_COORD_PRECISION)},${destination.longitude.toFixed(CACHE_COORD_PRECISION)}`;
  }
}
