// Must be set before AppModule (and therefore ConfigModule) is imported —
// the real value comes from the server's own .env, deliberately left unset
// there (no reset page exists yet, see PASSWORD_RESET_API_CONTRACT.md), so
// this test process sets its own dummy trusted origin to exercise the
// actual email-sending path end to end.
process.env.PASSWORD_RESET_URL = 'https://app.kebdazaman.cloud/reset-password';

import { createHash, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { AuthService } from '../src/modules/auth/auth.service';
import { EmailService } from '../src/modules/email/email.service';

const PASSWORD = 'correcthorsebattery';
const GENERIC_MESSAGE = 'If an account exists for this email, a password reset link has been sent.';

function uniqueEmail(label: string): string {
  return `${label}-${randomUUID()}@password-reset-test.local`;
}

/** Same SHA-256-hex scheme AuthService's own local `sha256` helper uses —
 * duplicated here only to seed a PasswordResetToken row directly by its
 * hash, for the one test that needs an "earlier live token" already in the
 * DB without going through the real (cooldown-gated) issuance path. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Pulls the raw token out of the resetLink the (mocked) EmailService was
 * called with — never reads it from a log, matching "never logs the token". */
function extractToken(mockCall: { resetLink: string }): string {
  const url = new URL(mockCall.resetLink);
  return url.searchParams.get('token')!;
}

/**
 * Same gating technique as driver-location-race.driver-location-race-spec.ts's
 * `gateFirstOfTwoTransactions`: holds the FIRST `$transaction` call open until
 * the SECOND has itself been invoked, guaranteeing both are genuinely
 * in-flight together before either one's atomic claim runs — proves the
 * claim's WHERE guard (not incidental call ordering) decides the outcome.
 */
function gateFirstOfTwoTransactions(prisma: PrismaService): { restore: () => void } {
  const original = prisma.$transaction.bind(prisma);
  let callCount = 0;
  let releaseFirstCall: () => void = () => undefined;
  const secondCallStarted = new Promise<void>((resolve) => {
    releaseFirstCall = resolve;
  });
  const spy = jest.spyOn(prisma, '$transaction').mockImplementation(((...args: unknown[]) => {
    return (async () => {
      callCount += 1;
      if (callCount === 1) {
        await secondCallStarted;
      } else if (callCount === 2) {
        releaseFirstCall();
      }

      return (original as any)(...args);
    })();
  }) as typeof prisma.$transaction);
  return { restore: () => spy.mockRestore() };
}

describe('Password reset (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authService: AuthService;
  let emailService: { sendPasswordResetEmail: jest.Mock };
  const createdUserIds: string[] = [];

  async function registerUser(overrides: Partial<{ email: string; password: string }> = {}) {
    const email = overrides.email ?? uniqueEmail('user');
    const password = overrides.password ?? PASSWORD;
    const result = await authService.register({ name: 'Reset Test User', email, password }, {});
    createdUserIds.push(result.user.id);
    return { ...result, email, password };
  }

  /** A social-sign-in-only account: has an email + firebaseUid, but no local
   * passwordHash — exactly what forgotPassword must treat as ineligible. */
  async function createFederatedOnlyUser() {
    const email = uniqueEmail('federated');
    const user = await prisma.user.create({
      data: {
        email,
        fullName: 'Federated Only',
        firebaseUid: `firebase-uid-${randomUUID()}`,
        passwordHash: null,
        role: 'CUSTOMER',
        isGuest: false,
      },
    });
    createdUserIds.push(user.id);
    return { email, id: user.id };
  }

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EmailService)
      .useValue({ sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined) })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    authService = app.get(AuthService);
    emailService = app.get(EmailService) as unknown as { sendPasswordResetEmail: jest.Mock };
  });

  afterEach(() => {
    emailService.sendPasswordResetEmail.mockClear();
    // The mock's default resolved behavior can be overwritten by individual
    // tests (e.g. to simulate a provider failure) — restore it so later
    // tests aren't affected.
    emailService.sendPasswordResetEmail.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  async function forgotPassword(email: string) {
    return request(app.getHttpServer()).post('/api/v1/auth/forgot-password').send({ email });
  }

  async function resetPassword(token: string, password: string) {
    return request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({ token, password });
  }

  // ---------------------------------------------------------------------
  describe('Full recovery round trip', () => {
    it('sends a reset email, resets the password, and the new password logs in while the old one is rejected', async () => {
      const { email } = await registerUser();

      const forgotRes = await forgotPassword(email);
      expect(forgotRes.status).toBe(200);
      expect(forgotRes.body.message).toBe(GENERIC_MESSAGE);
      expect(emailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
      const call = emailService.sendPasswordResetEmail.mock.calls[0][0];
      expect(call.to).toBe(email);
      const token = extractToken(call);

      const newPassword = 'brand-new-password-987';
      const resetRes = await resetPassword(token, newPassword);
      expect(resetRes.status).toBe(200);
      expect(resetRes.body).not.toHaveProperty('accessToken');
      expect(resetRes.body).not.toHaveProperty('refreshToken');

      const loginWithNew = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: newPassword });
      expect(loginWithNew.status).toBe(200);

      const loginWithOld = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD });
      expect(loginWithOld.status).toBe(401);
      expect(loginWithOld.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('stores only the token hash, never the raw token, in the database', async () => {
      const { email } = await registerUser();
      await forgotPassword(email);
      const token = extractToken(emailService.sendPasswordResetEmail.mock.calls[0][0]);

      const rows = await prisma.$queryRaw<Array<{ tokenHash: string }>>(
        Prisma.sql`SELECT "tokenHash" FROM "PasswordResetToken" ORDER BY "createdAt" DESC LIMIT 1`,
      );
      expect(rows[0].tokenHash).not.toBe(token);
      expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    });
  });

  // ---------------------------------------------------------------------
  describe('Generic response — no account enumeration', () => {
    it('is identical for an unknown email, a federated-only account, and a deleted account', async () => {
      const unknown = await forgotPassword(uniqueEmail('never-registered'));

      const federated = await createFederatedOnlyUser();
      const federatedRes = await forgotPassword(federated.email);

      const { email: deletedEmail, user } = await registerUser();
      await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
      const deletedRes = await forgotPassword(deletedEmail);

      for (const res of [unknown, federatedRes, deletedRes]) {
        expect(res.status).toBe(200);
        expect(res.body.message).toBe(GENERIC_MESSAGE);
      }
      expect(emailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('sends an email only for the eligible (existing, active, local-password) account', async () => {
      const { email } = await registerUser();
      await forgotPassword(email);
      expect(emailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------
  describe('Invalid / expired / reused tokens', () => {
    it('rejects a token that was never issued', async () => {
      const res = await resetPassword('this-token-was-never-issued', 'whatever12345');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_RESET_TOKEN');
    });

    it('rejects an expired token', async () => {
      const { email, user } = await registerUser();
      await forgotPassword(email);
      const token = extractToken(emailService.sendPasswordResetEmail.mock.calls[0][0]);

      await prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const res = await resetPassword(token, 'whatever12345');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('RESET_TOKEN_EXPIRED');
    });

    it('rejects a reused token on the second attempt', async () => {
      const { email } = await registerUser();
      await forgotPassword(email);
      const token = extractToken(emailService.sendPasswordResetEmail.mock.calls[0][0]);

      const first = await resetPassword(token, 'first-new-password-1');
      expect(first.status).toBe(200);

      const second = await resetPassword(token, 'second-new-password-2');
      expect(second.status).toBe(401);
      expect(second.body.code).toBe('RESET_TOKEN_ALREADY_USED');
    });

    it('invalidates an earlier live token when a newer one is issued for the same account', async () => {
      // The real forgot-password resend cooldown (60s) makes two real HTTP
      // calls for the same email impossible within a single test run, so
      // the "earlier live token" is seeded directly — same effect as an
      // earlier forgotPassword call would have had, without fighting the
      // cooldown it's independent from at the DB layer.
      const { email, user } = await registerUser();
      const earlierRawToken = `seeded-earlier-token-${randomUUID()}`;
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256(earlierRawToken),
          expiresAt: new Date(Date.now() + 15 * 60_000),
        },
      });

      await forgotPassword(email);
      const newToken = extractToken(emailService.sendPasswordResetEmail.mock.calls[0][0]);
      expect(newToken).not.toBe(earlierRawToken);

      const usingEarlier = await resetPassword(earlierRawToken, 'whatever12345');
      expect(usingEarlier.status).toBe(401);
      expect(usingEarlier.body.code).toBe('INVALID_RESET_TOKEN');

      const usingNew = await resetPassword(newToken, 'whatever12345');
      expect(usingNew.status).toBe(200);
    });

    it('rejects a password shorter than the policy minimum (400, DTO validation)', async () => {
      const res = await resetPassword('any-token-value', 'short');
      expect(res.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------
  describe('Concurrent submissions with the same token', () => {
    it('permits exactly one success; the other is rejected as already-used', async () => {
      const { email } = await registerUser();
      await forgotPassword(email);
      const token = extractToken(emailService.sendPasswordResetEmail.mock.calls[0][0]);

      const gate = gateFirstOfTwoTransactions(prisma);
      try {
        const [a, b] = await Promise.all([
          resetPassword(token, 'racer-password-one'),
          resetPassword(token, 'racer-password-two'),
        ]);

        const statuses = [a.status, b.status].sort();
        expect(statuses).toEqual([200, 401]);
        const failed = a.status === 401 ? a : b;
        expect(failed.body.code).toBe('RESET_TOKEN_ALREADY_USED');
      } finally {
        gate.restore();
      }
    });
  });

  // ---------------------------------------------------------------------
  describe('Session revocation on reset', () => {
    it('revokes every outstanding refresh-token session — an old refresh token is rejected after reset', async () => {
      const { email, refreshToken } = await registerUser();

      await forgotPassword(email);
      const token = extractToken(emailService.sendPasswordResetEmail.mock.calls[0][0]);
      await resetPassword(token, 'session-revocation-new-pw');

      const refreshAttempt = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });
      expect(refreshAttempt.status).toBe(401);
    });

    it('revokes sessions from every device, not just the one that requested the reset', async () => {
      const { email, password, refreshToken: sessionA } = await registerUser();
      const secondLogin = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password });
      const sessionB = secondLogin.body.refreshToken as string;

      await forgotPassword(email);
      const token = extractToken(emailService.sendPasswordResetEmail.mock.calls[0][0]);
      await resetPassword(token, 'multi-device-new-pw');

      const refreshA = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: sessionA });
      const refreshB = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: sessionB });
      expect(refreshA.status).toBe(401);
      expect(refreshB.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------
  describe('Resend provider failure', () => {
    it('still returns the generic 200 response when the email provider fails', async () => {
      const { email } = await registerUser();
      emailService.sendPasswordResetEmail.mockRejectedValueOnce(new Error('Resend is down'));

      const res = await forgotPassword(email);
      expect(res.status).toBe(200);
      expect(res.body.message).toBe(GENERIC_MESSAGE);
    });
  });

  // ---------------------------------------------------------------------
  // Uses its own freshly-booted app (fresh in-memory throttle/cooldown
  // state) so this burst neither depends on nor pollutes the shared app's
  // counters — same rationale as auth.auth-spec.ts's isolated rate-limit block.
  describe('Rate limiting & resend cooldown (isolated app instance)', () => {
    let throttleApp: INestApplication;
    let throttlePrisma: PrismaService;
    let throttleEmailService: { sendPasswordResetEmail: jest.Mock };
    const throttleCreatedIds: string[] = [];

    beforeAll(async () => {
      const moduleRef: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(EmailService)
        .useValue({ sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined) })
        .compile();
      throttleApp = moduleRef.createNestApplication();
      throttleApp.setGlobalPrefix('api');
      throttleApp.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
      throttleApp.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
      );
      throttleApp.useGlobalFilters(new AllExceptionsFilter());
      await throttleApp.init();
      throttlePrisma = throttleApp.get(PrismaService);
      throttleEmailService = throttleApp.get(EmailService) as unknown as {
        sendPasswordResetEmail: jest.Mock;
      };
    });

    afterAll(async () => {
      if (throttleCreatedIds.length > 0) {
        await throttlePrisma.user.deleteMany({ where: { id: { in: throttleCreatedIds } } });
      }
      await throttleApp.close();
    });

    it('returns 429 PASSWORD_RESET_COOLDOWN on a second forgot-password call for the same email within the cooldown', async () => {
      const email = uniqueEmail('cooldown');
      const first = await request(throttleApp.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email });
      expect(first.status).toBe(200);

      const second = await request(throttleApp.getHttpServer())
        .post('/api/v1/auth/forgot-password')
        .send({ email });
      expect(second.status).toBe(429);
      expect(second.body.code).toBe('PASSWORD_RESET_COOLDOWN');
    });

    it('returns 429 once the per-IP route throttle (AUTH_THROTTLE, 20/60s) is exceeded — distinct emails, so this is the IP limit, not the per-email cooldown', async () => {
      const responses = [];
      for (let i = 0; i < 25; i += 1) {
        responses.push(
          await request(throttleApp.getHttpServer())
            .post('/api/v1/auth/forgot-password')
            .send({ email: uniqueEmail(`ip-throttle-${i}`) }),
        );
      }
      expect(responses.some((r) => r.status === 429)).toBe(true);
      expect(throttleEmailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });
  });
});
