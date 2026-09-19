import { ConfigService } from '@nestjs/config';
import { EmailProviderError, EmailService, EmailUnavailableError } from './email.service';

function makeConfig(overrides: { apiKey?: string; from?: string; nodeEnv?: string } = {}) {
  // Explicit `'key' in overrides` checks (not destructuring defaults) so a
  // deliberately-passed `undefined` (e.g. { apiKey: undefined }) is honored
  // as "unset" instead of falling back to the default test value.
  const apiKey = 'apiKey' in overrides ? overrides.apiKey : 'test-resend-key';
  const from = 'from' in overrides ? overrides.from : 'Kebda Zaman <noreply@mail.kebdazaman.cloud>';
  const nodeEnv = overrides.nodeEnv ?? 'test';
  return {
    get: jest.fn((key: string) => {
      if (key === 'email.resendApiKey') return apiKey;
      if (key === 'email.from') return from;
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

describe('EmailService.sendPasswordResetEmail', () => {
  const originalFetch = global.fetch;
  const params = {
    to: 'customer@example.com',
    name: 'Sara',
    locale: 'en',
    resetLink: 'https://app.kebdazaman.cloud/reset-password?token=super-secret-token',
  };

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('POSTs to Resend with the configured from/recipient and the templated subject/html/text', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { id: 'email-id' }));
    const service = new EmailService(makeConfig());

    await service.sendPasswordResetEmail(params);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer test-resend-key');
    const body = JSON.parse(init.body);
    expect(body.from).toBe('Kebda Zaman <noreply@mail.kebdazaman.cloud>');
    expect(body.to).toEqual(['customer@example.com']);
    expect(body.subject).toContain('Reset your password');
    expect(body.html).toContain(params.resetLink);
  });

  it('never logs the API key, the reset link, or the recipient', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, {}));
    const service = new EmailService(makeConfig());
    const warnSpy = jest.spyOn(
      (service as unknown as { logger: { warn: () => void } }).logger,
      'warn',
    );

    await service.sendPasswordResetEmail(params);

    warnSpy.mock.calls.flat().forEach((arg) => {
      expect(String(arg)).not.toContain('test-resend-key');
      expect(String(arg)).not.toContain('super-secret-token');
      expect(String(arg)).not.toContain(params.to);
    });
  });

  it('throws EmailUnavailableError without calling fetch when RESEND_API_KEY is unset', async () => {
    global.fetch = jest.fn();
    const service = new EmailService(makeConfig({ apiKey: undefined }));

    await expect(service.sendPasswordResetEmail(params)).rejects.toBeInstanceOf(
      EmailUnavailableError,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws EmailUnavailableError without calling fetch when EMAIL_FROM is unset', async () => {
    global.fetch = jest.fn();
    const service = new EmailService(makeConfig({ from: undefined }));

    await expect(service.sendPasswordResetEmail(params)).rejects.toBeInstanceOf(
      EmailUnavailableError,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('reports isConfigured=false when either RESEND_API_KEY or EMAIL_FROM is missing', () => {
    expect(new EmailService(makeConfig({ apiKey: undefined })).isConfigured).toBe(false);
    expect(new EmailService(makeConfig({ from: undefined })).isConfigured).toBe(false);
    expect(new EmailService(makeConfig()).isConfigured).toBe(true);
  });

  it('maps a network failure/timeout to EmailUnavailableError', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));
    const service = new EmailService(makeConfig());

    await expect(service.sendPasswordResetEmail(params)).rejects.toBeInstanceOf(
      EmailUnavailableError,
    );
  });

  it('maps a non-2xx Resend response to EmailProviderError, carrying the HTTP status', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(422, { message: 'invalid from' }));
    const service = new EmailService(makeConfig());

    await expect(service.sendPasswordResetEmail(params)).rejects.toMatchObject({
      httpStatus: 422,
    });
    await expect(service.sendPasswordResetEmail(params)).rejects.toBeInstanceOf(EmailProviderError);
  });

  it('never retries — exactly one fetch call even on failure', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(500, {}));
    const service = new EmailService(makeConfig());

    await expect(service.sendPasswordResetEmail(params)).rejects.toBeInstanceOf(EmailProviderError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
