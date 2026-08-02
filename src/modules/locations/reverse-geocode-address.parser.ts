export interface GoogleAddressComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

export interface GoogleGeocodeResult {
  address_components: GoogleAddressComponent[];
  formatted_address: string;
  place_id: string;
  types: string[];
}

export interface ParsedAddress {
  formattedAddress: string;
  street: string | null;
  area: string | null;
  city: string | null;
  governorate: string | null;
  country: string | null;
  postalCode: string | null;
  placeId: string;
}

/** Preferred Google result types (VO2.2 spec) — most specific first, first match wins. */
const RESULT_TYPE_PREFERENCE = [
  'street_address',
  'premise',
  'subpremise',
  'route',
  'neighborhood',
  'sublocality',
  'locality',
] as const;

/**
 * Open Location Code ("Plus Code") shape, e.g. "7QR5+HQM" or the
 * "7QR5+HQM Cairo, Egypt" form Google returns for plus_code results.
 * Matched loosely (not the strict base-20 alphabet) so any lookalike is
 * also stripped from visible text — a Plus Code must never reach the client.
 */
const PLUS_CODE_PATTERN = /\b[A-Z0-9]{4,8}\+[A-Z0-9]{2,3}\b/gi;

export function containsPlusCode(text: string): boolean {
  PLUS_CODE_PATTERN.lastIndex = 0;
  return PLUS_CODE_PATTERN.test(text);
}

export function stripPlusCode(text: string): string {
  PLUS_CODE_PATTERN.lastIndex = 0;
  return text
    .replace(PLUS_CODE_PATTERN, '')
    .replace(/^[,\s]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Picks the best result from a Geocoding API `results[]` array: prefers a
 * human-readable result over a `plus_code` one whenever one exists (req. #7),
 * then the most specific type per RESULT_TYPE_PREFERENCE, falling back to
 * the first remaining (coarser) result when nothing on the list matches —
 * e.g. a result that only carries administrative_area_level_1/country.
 */
export function selectBestResult(results: GoogleGeocodeResult[]): GoogleGeocodeResult | null {
  if (results.length === 0) {
    return null;
  }

  const humanReadable = results.filter((result) => !result.types.includes('plus_code'));
  const candidates = humanReadable.length > 0 ? humanReadable : results;

  for (const type of RESULT_TYPE_PREFERENCE) {
    const match = candidates.find((result) => result.types.includes(type));
    if (match) {
      return match;
    }
  }
  return candidates[0];
}

/**
 * Indexes address_components by type — never by array position (req. #6).
 * A component's own `types` array can list more than one type; the first
 * component seen for a given type wins, which also dedups repeats (req. #10).
 */
export function indexComponentsByType(components: GoogleAddressComponent[]): Map<string, string> {
  const byType = new Map<string, string>();
  for (const component of components) {
    for (const type of component.types) {
      if (!byType.has(type)) {
        byType.set(type, component.long_name);
      }
    }
  }
  return byType;
}

function firstOf(byType: Map<string, string>, types: string[]): string | null {
  for (const type of types) {
    const value = byType.get(type);
    if (value) {
      return value;
    }
  }
  return null;
}

export function parseGeocodeResult(result: GoogleGeocodeResult): ParsedAddress {
  const byType = indexComponentsByType(result.address_components);

  const streetNumber = byType.get('street_number') ?? null;
  const route = byType.get('route') ?? null;
  const street = [route, streetNumber].filter(Boolean).join(' ').trim() || null;

  const area = firstOf(byType, [
    'neighborhood',
    'sublocality_level_1',
    'sublocality',
    'administrative_area_level_2',
  ]);
  const city = firstOf(byType, [
    'locality',
    'administrative_area_level_2',
    'administrative_area_level_1',
  ]);
  const governorate = byType.get('administrative_area_level_1') ?? null;
  const country = byType.get('country') ?? null;
  const postalCode = byType.get('postal_code') ?? null;

  // Coarse-data fallback (req.: "if only coarse address data is available,
  // return the available human-readable fields") — never falls back to raw
  // coordinates as visible text.
  const formattedAddress =
    stripPlusCode(result.formatted_address) || street || city || country || '';

  return {
    formattedAddress,
    street,
    area,
    city,
    governorate,
    country,
    postalCode,
    placeId: result.place_id,
  };
}
