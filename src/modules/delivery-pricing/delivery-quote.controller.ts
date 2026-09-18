import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../../common/decorators/roles.decorator';
import { SENSITIVE_ROUTE_THROTTLE } from '../../common/constants/sensitive-route-throttle.const';
import { DeliveryPricingService, DeliveryQuoteResult } from './delivery-pricing.service';
import { DeliveryQuoteDto } from './dto/delivery-quote.dto';

export interface DeliveryQuoteResponseDto {
  deliverable: boolean;
  distanceMeters: number;
  distanceKm: string;
  durationSeconds: number;
  durationMinutes: number;
  currency: string;
  deliveryFee: string | null;
  minimumOrder: string | null;
  tier: { id: string; minDistanceKm: string; maxDistanceKm: string } | null;
  reason?: string;
}

function toDeliveryQuoteResponse(result: DeliveryQuoteResult): DeliveryQuoteResponseDto {
  return {
    deliverable: result.deliverable,
    distanceMeters: result.distanceMeters,
    distanceKm: (result.distanceMeters / 1000).toFixed(2),
    durationSeconds: result.durationSeconds,
    durationMinutes: Math.round(result.durationSeconds / 60),
    currency: result.currency,
    deliveryFee: result.tier ? result.tier.deliveryFee.toFixed(2) : null,
    minimumOrder: result.tier ? result.tier.minimumOrder.toFixed(2) : null,
    tier: result.tier
      ? {
          id: result.tier.id,
          minDistanceKm: result.tier.minDistanceKm.toFixed(2),
          maxDistanceKm: result.tier.maxDistanceKm.toFixed(2),
        }
      : null,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

/** VO3: server-side delivery-quote pricing. The client only ever sends a
 * destination — origin, travel mode, tier match, and every money figure are
 * always resolved server-side (see DeliveryPricingService). This quote is
 * advisory only; checkout always recalculates authoritatively and never
 * trusts a value returned from here. Restricted to authenticated customers
 * (same convention as the sibling LocationsController.reverseGeocode — both
 * proxy a paid, rate-limited Google API and are deliberately not @Public()). */
@Roles('CUSTOMER')
@Controller({ path: 'delivery', version: '1' })
export class DeliveryQuoteController {
  constructor(private readonly deliveryPricingService: DeliveryPricingService) {}

  @HttpCode(HttpStatus.OK)
  @Throttle(SENSITIVE_ROUTE_THROTTLE)
  @Post('quote')
  async quote(@Body() dto: DeliveryQuoteDto): Promise<DeliveryQuoteResponseDto> {
    const result = await this.deliveryPricingService.getCachedQuote({
      latitude: dto.latitude,
      longitude: dto.longitude,
    });
    return toDeliveryQuoteResponse(result);
  }
}
