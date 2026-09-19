import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildPasswordResetEmail } from './password-reset-email.template';

const RESEND_API_BASE = 'https://api.resend.com';
const EMAIL_TIMEOUT_MS = 8000;

/** Thrown for network failure, timeout, or missing server configuration — always transient/operational, never the recipient's fault. */
export class EmailUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailUnavailableError';
  }
}

/** Thrown for a well-formed Resend API error response (4xx/5xx with a JSON body). */
export class EmailProviderError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: unknown,
  ) {
    super(`Resend API error (HTTP ${httpStatus})`);
    this.name = 'EmailProviderError';
  }
}

export interface SendPasswordResetEmailParams {
  to: string;
  name: string;
  locale: string;
  resetLink: string;
}

/**
 * Backend-only Resend API client. Modeled directly on MoyasarClientService /
 * GoogleRoutesService: AbortController timeout, single attempt (no retry —
 * callers decide whether/how to react to a failure; for password reset,
 * AuthService deliberately never retries and never lets a failure here
 * change its generic response), typed error mapping, secret read from
 * ConfigService only, never logged. Raw `fetch` against Resend's REST API
 * rather than their SDK — no other integration in this codebase uses a
 * provider SDK either (Moyasar, Google Routes/Geocoding all use fetch).
 *
 * NEVER logs the email body/subject/recipient or the API key — only the
 * failure class/HTTP status, matching the "no secrets, no reset links, no
 * tokens in logs" requirement for this feature.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly config: ConfigService) {
    if (!this.isConfigured) {
      const message =
        'RESEND_API_KEY/EMAIL_FROM are not fully configured — no transactional email (e.g. password reset) can be sent until both are set.';
      if (this.config.get<string>('nodeEnv') === 'production') {
        this.logger.error(`${message} This is unexpected in production.`);
      } else {
        this.logger.warn(message);
      }
    }
  }

  get isConfigured(): boolean {
    return (
      Boolean(this.config.get<string>('email.resendApiKey')) &&
      Boolean(this.config.get<string>('email.from'))
    );
  }

  async sendPasswordResetEmail(params: SendPasswordResetEmailParams): Promise<void> {
    const apiKey = this.config.get<string>('email.resendApiKey');
    const from = this.config.get<string>('email.from');
    if (!apiKey || !from) {
      throw new EmailUnavailableError('Email sending is not configured on the server');
    }

    const { subject, html, text } = buildPasswordResetEmail({
      name: params.name,
      resetLink: params.resetLink,
      locale: params.locale,
    });

    await this.send(apiKey, {
      from,
      to: [params.to],
      subject,
      html,
      text,
    });
  }

  private async send(apiKey: string, body: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${RESEND_API_BASE}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      this.logger.warn(
        `Resend request failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      throw new EmailUnavailableError('Email provider request failed');
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        responseBody = undefined;
      }
      this.logger.warn(`Resend API error: HTTP ${response.status}`);
      throw new EmailProviderError(response.status, responseBody);
    }
  }
}
