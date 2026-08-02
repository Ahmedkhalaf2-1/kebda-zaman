import {
  GoogleGeocodeResult,
  containsPlusCode,
  indexComponentsByType,
  parseGeocodeResult,
  selectBestResult,
  stripPlusCode,
} from './reverse-geocode-address.parser';

function result(overrides: Partial<GoogleGeocodeResult>): GoogleGeocodeResult {
  return {
    address_components: [],
    formatted_address: '',
    place_id: 'place-1',
    types: [],
    ...overrides,
  };
}

describe('containsPlusCode / stripPlusCode', () => {
  it('detects a Plus Code embedded in a formatted address', () => {
    expect(containsPlusCode('7QR5+HQM Cairo, Egypt')).toBe(true);
  });

  it('does not flag a normal formatted address', () => {
    expect(containsPlusCode('26 July St, Cairo, Egypt')).toBe(false);
  });

  it('strips the Plus Code and leftover punctuation, leaving the human-readable remainder', () => {
    expect(stripPlusCode('7QR5+HQM Cairo, Egypt')).toBe('Cairo, Egypt');
  });

  it('is a no-op on text with no Plus Code', () => {
    expect(stripPlusCode('26 July St, Cairo, Egypt')).toBe('26 July St, Cairo, Egypt');
  });
});

describe('selectBestResult', () => {
  it('prefers a human-readable result over a plus_code result', () => {
    const plusCode = result({ types: ['plus_code'], formatted_address: '7QR5+HQM Cairo' });
    const route = result({ types: ['route'], formatted_address: '26 July St, Cairo' });

    expect(selectBestResult([plusCode, route])).toBe(route);
  });

  it('prefers a more specific type per the preference order (street_address over route)', () => {
    const route = result({ types: ['route'] });
    const streetAddress = result({ types: ['street_address', 'route'] });

    expect(selectBestResult([route, streetAddress])).toBe(streetAddress);
  });

  it('falls back to the first remaining result when nothing matches the preference list (coarse data)', () => {
    const country = result({ types: ['country', 'political'] });
    expect(selectBestResult([country])).toBe(country);
  });

  it('falls back to a plus_code result only when it is the sole result available', () => {
    const plusCode = result({ types: ['plus_code'] });
    expect(selectBestResult([plusCode])).toBe(plusCode);
  });

  it('returns null for an empty results array', () => {
    expect(selectBestResult([])).toBeNull();
  });
});

describe('indexComponentsByType', () => {
  it('indexes by each type a component carries, not by array position', () => {
    const byType = indexComponentsByType([
      { long_name: 'Cairo', short_name: 'Cairo', types: ['locality', 'political'] },
    ]);
    expect(byType.get('locality')).toBe('Cairo');
    expect(byType.get('political')).toBe('Cairo');
  });

  it('dedupes repeated components for the same type, keeping the first', () => {
    const byType = indexComponentsByType([
      { long_name: 'Cairo Governorate', short_name: 'C', types: ['administrative_area_level_1'] },
      { long_name: 'Duplicate Value', short_name: 'D', types: ['administrative_area_level_1'] },
    ]);
    expect(byType.get('administrative_area_level_1')).toBe('Cairo Governorate');
  });
});

describe('parseGeocodeResult', () => {
  it('maps address_components by type into the response fields', () => {
    const parsed = parseGeocodeResult(
      result({
        formatted_address: '12 شارع النصر, مصر الجديدة, القاهرة, مصر',
        place_id: 'place-abc',
        types: ['street_address'],
        address_components: [
          { long_name: '12', short_name: '12', types: ['street_number'] },
          { long_name: 'شارع النصر', short_name: 'شارع النصر', types: ['route'] },
          {
            long_name: 'مصر الجديدة',
            short_name: 'مصر الجديدة',
            types: ['neighborhood', 'political'],
          },
          { long_name: 'القاهرة', short_name: 'القاهرة', types: ['locality', 'political'] },
          {
            long_name: 'محافظة القاهرة',
            short_name: 'القاهرة',
            types: ['administrative_area_level_1'],
          },
          { long_name: 'مصر', short_name: 'EG', types: ['country', 'political'] },
          { long_name: '11511', short_name: '11511', types: ['postal_code'] },
        ],
      }),
    );

    expect(parsed).toEqual({
      formattedAddress: '12 شارع النصر, مصر الجديدة, القاهرة, مصر',
      street: 'شارع النصر 12',
      area: 'مصر الجديدة',
      city: 'القاهرة',
      governorate: 'محافظة القاهرة',
      country: 'مصر',
      postalCode: '11511',
      placeId: 'place-abc',
    });
  });

  it('strips a Plus Code out of the formatted address', () => {
    const parsed = parseGeocodeResult(
      result({
        formatted_address: '7QR5+HQM Cairo, Egypt',
        types: ['plus_code'],
        address_components: [{ long_name: 'Cairo', short_name: 'Cairo', types: ['locality'] }],
      }),
    );

    expect(parsed.formattedAddress).toBe('Cairo, Egypt');
    expect(containsPlusCode(parsed.formattedAddress)).toBe(false);
  });

  it('falls back through the area chain to administrative_area_level_2 when no neighborhood/sublocality exists', () => {
    const parsed = parseGeocodeResult(
      result({
        formatted_address: 'Some District, Egypt',
        address_components: [
          {
            long_name: 'Some District',
            short_name: 'Some District',
            types: ['administrative_area_level_2'],
          },
        ],
      }),
    );

    expect(parsed.area).toBe('Some District');
    expect(parsed.city).toBe('Some District');
  });

  it('returns null fields (never invented text) when no matching components exist', () => {
    const parsed = parseGeocodeResult(result({ formatted_address: 'Egypt' }));

    expect(parsed.street).toBeNull();
    expect(parsed.area).toBeNull();
    expect(parsed.city).toBeNull();
    expect(parsed.governorate).toBeNull();
    expect(parsed.postalCode).toBeNull();
    expect(parsed.formattedAddress).toBe('Egypt');
  });
});
