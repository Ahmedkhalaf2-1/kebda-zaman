import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReverseGeocodeDto } from './dto/reverse-geocode.dto';
import {
  GoogleGeocodeResult,
  parseGeocodeResult,
  selectBestResult,
} from './reverse-geocode-address.parser';

const GOOGLE_GEOCODE_ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';
const GEOCODE_TIMEOUT_MS = 5000;

export interface ReverseGeocodeResponseDto {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  street: string | null;
  area: string | null;
  city: string | null;
  governorate: string | null;
  country: string | null;
  postalCode: string | null;
  placeId: string;
  source: 'google';
}

interface GoogleGeocodeApiResponse {
  status: string;
  error_message?: string;
  results: GoogleGeocodeResult[];
}

/** VO2.2: server-side reverse geocoding via the Google Geocoding API. */
@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);

  constructor(private readonly config: ConfigService) {}

  async reverseGeocode(dto: ReverseGeocodeDto): Promise<ReverseGeocodeResponseDto> {
    const apiKey = this.config.get<string>('googleGeocoding.apiKey');
    if (!apiKey) {
      this.logger.warn('Reverse geocode requested but GOOGLE_GEOCODING_API_KEY is not configured');
      throw new BadGatewayException({
        message: 'Reverse geocoding is not configured on the server',
        code: 'GEOCODING_PROVIDER_CONFIG_ERROR',
      });
    }

    // Coordinates truncated to ~11km precision — never log the exact fix at info/debug level.
    this.logger.debug(
      `Reverse geocode requested (lat≈${dto.latitude.toFixed(1)}, lng≈${dto.longitude.toFixed(1)})`,
    );

    const payload = await this.callGoogle(dto.latitude, dto.longitude, apiKey);
    const result = this.selectResultOrThrow(payload);
    const parsed = parseGeocodeResult(result);

    return {
      latitude: dto.latitude,
      longitude: dto.longitude,
      formattedAddress: parsed.formattedAddress,
      street: parsed.street,
      area: parsed.area,
      city: parsed.city,
      governorate: parsed.governorate,
      country: parsed.country,
      postalCode: parsed.postalCode,
      placeId: parsed.placeId,
      source: 'google',
    };
  }

  private async callGoogle(
    latitude: number,
    longitude: number,
    apiKey: string,
  ): Promise<GoogleGeocodeApiResponse> {
    const url = new URL(GOOGLE_GEOCODE_ENDPOINT);
    url.searchParams.set('latlng', `${latitude},${longitude}`);
    url.searchParams.set('language', 'ar');
    url.searchParams.set('region', 'eg');
    url.searchParams.set('key', apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (error) {
      this.logger.error(
        `Reverse geocode request to Google failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      throw new GatewayTimeoutException({
        message: 'Reverse geocoding provider did not respond in time',
        code: 'GEOCODING_TIMEOUT',
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      this.logger.error(`Google Geocoding API returned HTTP ${response.status}`);
      throw new BadGatewayException({
        message: 'Reverse geocoding provider returned an unexpected error',
        code: 'GEOCODING_TEMPORARY_ERROR',
      });
    }

    return (await response.json()) as GoogleGeocodeApiResponse;
  }

  private selectResultOrThrow(payload: GoogleGeocodeApiResponse): GoogleGeocodeResult {
    switch (payload.status) {
      case 'OK':
        break;
      case 'ZERO_RESULTS':
        throw new NotFoundException({
          message: 'No address found for the given coordinates',
          code: 'GEOCODING_ZERO_RESULTS',
        });
      case 'INVALID_REQUEST':
        throw new BadRequestException({
          message: 'Invalid coordinates for reverse geocoding',
          code: 'GEOCODING_INVALID_REQUEST',
        });
      case 'REQUEST_DENIED':
        this.logger.error('Google Geocoding API denied the request (check provider configuration)');
        throw new BadGatewayException({
          message: 'Reverse geocoding provider rejected the request',
          code: 'GEOCODING_PROVIDER_CONFIG_ERROR',
        });
      case 'OVER_QUERY_LIMIT':
        this.logger.warn('Google Geocoding API quota exceeded');
        throw new ServiceUnavailableException({
          message: 'Reverse geocoding is temporarily unavailable',
          code: 'GEOCODING_QUOTA_EXCEEDED',
        });
      default:
        // Covers UNKNOWN_ERROR and any status not explicitly modeled above.
        this.logger.error(`Google Geocoding API returned status ${payload.status}`);
        throw new BadGatewayException({
          message: 'Reverse geocoding provider returned an unexpected error',
          code: 'GEOCODING_TEMPORARY_ERROR',
        });
    }

    const result = selectBestResult(payload.results ?? []);
    if (!result) {
      throw new NotFoundException({
        message: 'No address found for the given coordinates',
        code: 'GEOCODING_ZERO_RESULTS',
      });
    }
    return result;
  }
}
