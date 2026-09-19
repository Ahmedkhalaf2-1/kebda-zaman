// AuthService statically imports GoogleAuthService, which imports
// firebase-admin/auth — mocked here so this unit test never pulls in the
// real Admin SDK (it transitively depends on ESM-only packages Jest can't
// parse without this).
jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn() }));
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User, UserRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { BruteForceService } from './brute-force.service';
import { PasswordResetThrottleService } from './password-reset-throttle.service';
import { GoogleAuthService } from './google-auth.service';
import { EmailService } from '../email/email.service';

const META = { ip: '203.0.113.7', userAgent: 'jest' };
const GENERIC_MESSAGE = 'If an account exists for this email, a password reset link has been sent.';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'customer@example.com',
    passwordHash: '$argon2id$v=19$...',
    firebaseUid: null,
    fullName: 'Jane Doe',
    phone: null,
    avatarUrl: null,
    role: UserRole.CUSTOMER,
    isGuest: false,
    locale: 'en',
    onboardingCompleted: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as User;
}

describe('AuthService.forgotPassword', () => {
  let prisma: {
    user: { findFirst: jest.Mock };
    $transaction: jest.Mock;
    passwordResetToken: { deleteMany: jest.Mock; create: jest.Mock };
  };
  let emailService: { sendPasswordResetEmail: jest.Mock };
  let throttle: { assertAllowedAndRecord: jest.Mock };
  let config: { get: jest.Mock };
  let service: AuthService;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    prisma = {
      user: { findFirst: jest.fn() },
      $transaction: jest.fn().mockResolvedValue(undefined),
      passwordResetToken: { deleteMany: jest.fn(), create: jest.fn() },
    };
    emailService = { sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined) };
    throttle = { assertAllowedAndRecord: jest.fn() };
    config = {
      get: jest.fn((key: string) =>
        key === 'passwordReset.url' ? 'https://app.example.com/reset' : undefined,
      ),
    };
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    service = new AuthService(
      prisma as unknown as PrismaService,
      {} as PasswordService,
      {} as TokenService,
      {} as BruteForceService,
      throttle as unknown as PasswordResetThrottleService,
      {} as GoogleAuthService,
      emailService as unknown as EmailService,
      config as unknown as ConfigService,
    );
  });

  afterEach(() => {
    warnSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('checks the per-email throttle before touching the database', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await service.forgotPassword({ email: 'nobody@example.com' }, META);
    expect(throttle.assertAllowedAndRecord).toHaveBeenCalledWith('nobody@example.com');
  });

  it('propagates a throttle rejection without ever querying the database', async () => {
    const throttled = new Error('throttled');
    throttle.assertAllowedAndRecord.mockImplementation(() => {
      throw throttled;
    });

    await expect(service.forgotPassword({ email: 'a@example.com' }, META)).rejects.toBe(throttled);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('returns the generic message and issues a token + email for an eligible account', async () => {
    const user = makeUser();
    prisma.user.findFirst.mockResolvedValue(user);

    const result = await service.forgotPassword({ email: user.email! }, META);

    expect(result).toEqual({ message: GENERIC_MESSAGE });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(emailService.sendPasswordResetEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: user.email, name: user.fullName, locale: user.locale }),
    );
    const linkArg = emailService.sendPasswordResetEmail.mock.calls[0][0].resetLink as string;
    expect(linkArg).toMatch(/^https:\/\/app\.example\.com\/reset\?token=/);
  });

  it('returns the SAME generic message for an unknown email — never queries a token/email', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    const result = await service.forgotPassword({ email: 'unknown@example.com' }, META);

    expect(result).toEqual({ message: GENERIC_MESSAGE });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(emailService.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('returns the SAME generic message for a federated-only account (no local passwordHash) — never sends an email', async () => {
    prisma.user.findFirst.mockResolvedValue(
      makeUser({ passwordHash: null, firebaseUid: 'google-uid-1' }),
    );

    const result = await service.forgotPassword({ email: 'social@example.com' }, META);

    expect(result).toEqual({ message: GENERIC_MESSAGE });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(emailService.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('returns the SAME generic message for a deleted account — findFirst already filters deletedAt: null', async () => {
    // AuthService queries with `deletedAt: null`, so a deleted account simply
    // never matches — asserting the query shape here, not re-deriving Prisma's behavior.
    prisma.user.findFirst.mockResolvedValue(null);

    const result = await service.forgotPassword({ email: 'deleted@example.com' }, META);

    expect(result).toEqual({ message: GENERIC_MESSAGE });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { email: 'deleted@example.com', deletedAt: null },
    });
  });

  it('never lets an email-provider failure change the response or propagate', async () => {
    prisma.user.findFirst.mockResolvedValue(makeUser());
    emailService.sendPasswordResetEmail.mockRejectedValue(new Error('Resend is down'));

    const result = await service.forgotPassword({ email: 'customer@example.com' }, META);

    expect(result).toEqual({ message: GENERIC_MESSAGE });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('never sends an email (but still responds generically) when PASSWORD_RESET_URL is unconfigured', async () => {
    prisma.user.findFirst.mockResolvedValue(makeUser());
    config.get.mockReturnValue(undefined);

    const result = await service.forgotPassword({ email: 'customer@example.com' }, META);

    expect(result).toEqual({ message: GENERIC_MESSAGE });
    expect(emailService.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('invalidates any prior unused token before issuing a new one (only one live token per user)', async () => {
    const user = makeUser();
    prisma.user.findFirst.mockResolvedValue(user);

    await service.forgotPassword({ email: user.email! }, META);

    expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: user.id, usedAt: null },
    });
    expect(prisma.passwordResetToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: user.id, requestIp: META.ip }),
      }),
    );
    // Both run inside one array-form transaction — atomic replace, not two
    // independent writes.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect((prisma.$transaction.mock.calls[0][0] as unknown[]).length).toBe(2);
  });

  it('never logs the raw reset token or the generated reset link', async () => {
    prisma.user.findFirst.mockResolvedValue(makeUser());
    emailService.sendPasswordResetEmail.mockRejectedValue(new Error('boom'));

    await service.forgotPassword({ email: 'customer@example.com' }, META);

    const linkArg = emailService.sendPasswordResetEmail.mock.calls[0][0].resetLink as string;
    const rawToken = linkArg.split('token=')[1];
    warnSpy.mock.calls.flat().forEach((arg) => {
      expect(String(arg)).not.toContain(rawToken);
    });
  });
});
