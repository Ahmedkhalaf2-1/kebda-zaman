import { ConfigService } from '@nestjs/config';
import { GoogleRoutesService } from './google-routes.service';

const ORIGIN = { latitude: 21.5705641, longitude: 39.1681808 };
const DESTINATION = { latitude: 21.6, longitude: 39.2 };

function makeConfig(apiKey: string | undefined, nodeEnv = 'test') {
  return {
    get: jest.fn((key: string) => {
      if (key === 'googleRoutes.apiKey') return apiKey;
      if (key === 'nodeEnv') return nodeEnv;
      return undefined;
    }),
  } as unknown as ConfigService;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('GoogleRoutesService.computeRoute', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns distance/duration on a successful response, never logging the API key', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { routes: [{ distanceMeters: 13_420, duration: '1260s' }] }),
      );
    const service = new GoogleRoutesService(makeConfig('test-routes-key'));

    const result = await service.computeRoute(ORIGIN, DESTINATION);

    expect(result).toEqual({ distanceMeters: 13_420, durationSeconds: 1260 });
    const [, requestInit] = (global.fetch as jest.Mock).mock.calls[0];
    expect(requestInit.headers['X-Goog-Api-Key']).toBe('test-routes-key');
    expect(requestInit.body).not.toContain('test-routes-key');
  });

  it('fails with a controlled 502 when GOOGLE_ROUTES_API_KEY is unset — never calls Google', async () => {
    global.fetch = jest.fn();
    const service = new GoogleRoutesService(makeConfig(undefined));

    await expect(service.computeRoute(ORIGIN, DESTINATION)).rejects.toMatchObject({
      response: { code: 'ROUTES_PROVIDER_CONFIG_ERROR' },
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('maps a fetch timeout/network failure to a 504', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));
    const service = new GoogleRoutesService(makeConfig('test-routes-key'));

    await expect(service.computeRoute(ORIGIN, DESTINATION)).rejects.toMatchObject({
      response: { code: 'ROUTES_TIMEOUT' },
    });
  });

  it('maps HTTP 403 (permission/API-disabled) to a controlled 502', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(403, { error: { message: 'denied' } }));
    const service = new GoogleRoutesService(makeConfig('test-routes-key'));

    await expect(service.computeRoute(ORIGIN, DESTINATION)).rejects.toMatchObject({
      response: { code: 'ROUTES_PROVIDER_CONFIG_ERROR' },
    });
  });

  it('maps HTTP 429 (quota) to a controlled 503', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(429, {}));
    const service = new GoogleRoutesService(makeConfig('test-routes-key'));

    await expect(service.computeRoute(ORIGIN, DESTINATION)).rejects.toMatchObject({
      response: { code: 'ROUTES_QUOTA_EXCEEDED' },
    });
  });

  it('maps other non-2xx responses to a controlled 502', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(500, {}));
    const service = new GoogleRoutesService(makeConfig('test-routes-key'));

    await expect(service.computeRoute(ORIGIN, DESTINATION)).rejects.toMatchObject({
      response: { code: 'ROUTES_TEMPORARY_ERROR' },
    });
  });

  it('maps a malformed (non-JSON) body to a controlled 502', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as unknown as Response);
    const service = new GoogleRoutesService(makeConfig('test-routes-key'));

    await expect(service.computeRoute(ORIGIN, DESTINATION)).rejects.toMatchObject({
      response: { code: 'ROUTES_TEMPORARY_ERROR' },
    });
  });

  it('maps an empty routes[] (no drivable route) to a controlled 422', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { routes: [] }));
    const service = new GoogleRoutesService(makeConfig('test-routes-key'));

    await expect(service.computeRoute(ORIGIN, DESTINATION)).rejects.toMatchObject({
      response: { code: 'ROUTES_NO_ROUTE_FOUND' },
    });
  });
});
