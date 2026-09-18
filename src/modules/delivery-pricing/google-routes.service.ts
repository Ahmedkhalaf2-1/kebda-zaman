import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const GOOGLE_ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const ROUTES_TIMEOUT_MS = 6000;
const ROUTES_FIELD_MASK = 'routes.distanceMeters,routes.duration';

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface RouteDistance {
  distanceMeters: number;
  durationSeconds: number;
}

interface GoogleComputeRoutesResponse {
  routes?: Array<{ distanceMeters?: number; duration?: string }>;
}

/**
 * Backend-only Google Routes API client (Compute Routes, DRIVE mode). Never
 * called from Flutter — travel mode and the restaurant origin are always
 * server-constructed, never client-supplied. Modeled directly on
 * LocationsService (reverse geocoding): AbortController timeout, single
 * attempt (no retry), typed error mapping, API key from ConfigService only,
 * never logged.
 */
@Injectable()
export class GoogleRoutesService {
  private readonly logger = new Logger(GoogleRoutesService.name);

  constructor(private readonly config: ConfigService) {
    // Startup-time visibility (mirrors firebase-admin.provider.ts): a
    // missing key must never fail boot, but in production it's a
    // misconfiguration worth paging on, not routine background noise.
    if (!this.config.get<string>('googleRoutes.apiKey')) {
      const message =
        'GOOGLE_ROUTES_API_KEY is not configured — distance-based delivery pricing (quote + checkout) will fail every request until it is set.';
      if (this.config.get<string>('nodeEnv') === 'production') {
        this.logger.error(`${message} This is unexpected in production.`);
      } else {
        this.logger.warn(message);
      }
    }
  }

  async computeRoute(origin: LatLng, destination: LatLng): Promise<RouteDistance> {
    const apiKey = this.config.get<string>('googleRoutes.apiKey');
    if (!apiKey) {
      this.logger.warn('Route distance requested but GOOGLE_ROUTES_API_KEY is not configured');
      throw new BadGatewayException({
        message: 'Delivery distance pricing is not configured on the server',
        code: 'ROUTES_PROVIDER_CONFIG_ERROR',
      });
    }

    const payload = await this.callGoogle(origin, destination, apiKey);
    return this.selectRouteOrThrow(payload);
  }

  private async callGoogle(
    origin: LatLng,
    destination: LatLng,
    apiKey: string,
  ): Promise<GoogleComputeRoutesResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ROUTES_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(GOOGLE_ROUTES_ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': ROUTES_FIELD_MASK,
        },
        body: JSON.stringify({
          origin: {
            location: { latLng: { latitude: origin.latitude, longitude: origin.longitude } },
          },
          destination: {
            location: {
              latLng: { latitude: destination.latitude, longitude: destination.longitude },
            },
          },
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_UNAWARE',
        }),
      });
    } catch (error) {
      // Never logs headers/body (the API key lives only in the header set above).
      this.logger.error(
        `Route distance request to Google failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      throw new GatewayTimeoutException({
        message: 'Delivery distance provider did not respond in time',
        code: 'ROUTES_TIMEOUT',
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 403) {
      this.logger.error('Google Routes API denied the request (check provider configuration)');
      throw new BadGatewayException({
        message: 'Delivery distance provider rejected the request',
        code: 'ROUTES_PROVIDER_CONFIG_ERROR',
      });
    }
    if (response.status === 429) {
      this.logger.warn('Google Routes API quota exceeded');
      throw new ServiceUnavailableException({
        message: 'Delivery distance pricing is temporarily unavailable',
        code: 'ROUTES_QUOTA_EXCEEDED',
      });
    }
    if (!response.ok) {
      this.logger.error(`Google Routes API returned HTTP ${response.status}`);
      throw new BadGatewayException({
        message: 'Delivery distance provider returned an unexpected error',
        code: 'ROUTES_TEMPORARY_ERROR',
      });
    }

    try {
      return (await response.json()) as GoogleComputeRoutesResponse;
    } catch {
      this.logger.error('Google Routes API returned a malformed response body');
      throw new BadGatewayException({
        message: 'Delivery distance provider returned an unexpected error',
        code: 'ROUTES_TEMPORARY_ERROR',
      });
    }
  }

  private selectRouteOrThrow(payload: GoogleComputeRoutesResponse): RouteDistance {
    const route = payload.routes?.[0];
    if (!route || typeof route.distanceMeters !== 'number') {
      throw new UnprocessableEntityException({
        message: 'No drivable route was found for the given coordinates',
        code: 'ROUTES_NO_ROUTE_FOUND',
      });
    }

    const durationSeconds = this.parseDurationSeconds(route.duration);
    return { distanceMeters: route.distanceMeters, durationSeconds };
  }

  /** Google returns duration as a string like "1260s". Malformed/missing -> 0 (distance is authoritative for pricing, duration is informational). */
  private parseDurationSeconds(duration: string | undefined): number {
    if (!duration) {
      return 0;
    }
    const parsed = parseInt(duration.replace(/s$/, ''), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
