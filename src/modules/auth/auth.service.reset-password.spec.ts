// AuthService statically imports GoogleAuthService, which imports
// firebase-admin/auth — mocked here so this unit test never pulls in the
// real Admin SDK (it transitively depends on ESM-only packages Jest can't
// parse without this).
jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn() }));
import { UnauthorizedException } from '@nestjs/common';
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

const RAW_TOKEN = 'a-raw-opaque-reset-token';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'customer@example.com',
    passwordHash: '$argon2id$v=19$old-hash',
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

describe('AuthService.resetPassword', () => {
  let tx: {
    passwordResetToken: {
      updateMany: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
    user: { findUnique: jest.Mock; update: jest.Mock };
    refreshToken: { updateMany: jest.Mock };
  };
  let prisma: { $transaction: jest.Mock };
  let passwordService: { hash: jest.Mock };
  let service: AuthService;

  beforeEach(() => {
    tx = {
      passwordResetToken: {
        updateMany: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      user: { findUnique: jest.fn(), update: jest.fn() },
      refreshToken: { updateMany: jest.fn() },
    };
    prisma = {
      $transaction: jest.fn((callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    };
    passwordService = { hash: jest.fn().mockResolvedValue('$argon2id$v=19$new-hash') };

    service = new AuthService(
      prisma as unknown as PrismaService,
      passwordService as unknown as PasswordService,
      {} as TokenService,
      {} as BruteForceService,
      {} as PasswordResetThrottleService,
      {} as GoogleAuthService,
      {} as EmailService,
      {} as ConfigService,
    );
  });

  it('on a valid, unclaimed, unexpired token: atomically claims it, hashes+updates the password, invalidates other tokens, and revokes all refresh sessions', async () => {
    tx.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
    tx.passwordResetToken.findUniqueOrThrow.mockResolvedValue({
      id: 'token-1',
      userId: 'user-1',
    });
    tx.user.findUnique.mockResolvedValue(makeUser());

    const result = await service.resetPassword({ token: RAW_TOKEN, password: 'new-password-123' });

    expect(passwordService.hash).toHaveBeenCalledWith('new-password-123');
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { passwordHash: '$argon2id$v=19$new-hash' },
    });
    expect(tx.passwordResetToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', usedAt: null },
        data: { usedAt: expect.any(Date) },
      }),
    );
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(result.message).toMatch(/reset/i);
  });

  it('claims the token via a single atomic updateMany scoped by tokenHash + usedAt:null + not-yet-expired', async () => {
    tx.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
    tx.passwordResetToken.findUniqueOrThrow.mockResolvedValue({ id: 't', userId: 'user-1' });
    tx.user.findUnique.mockResolvedValue(makeUser());

    await service.resetPassword({ token: RAW_TOKEN, password: 'new-password-123' });

    const claimCall = tx.passwordResetToken.updateMany.mock.calls[0][0];
    expect(claimCall.where.usedAt).toBeNull();
    expect(claimCall.where.expiresAt).toEqual({ gt: expect.any(Date) });
    expect(claimCall.data.usedAt).toBeInstanceOf(Date);
  });

  it('rejects an unknown token with 401 INVALID_RESET_TOKEN, never touches the user', async () => {
    tx.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });
    tx.passwordResetToken.findUnique.mockResolvedValue(null);

    await expect(
      service.resetPassword({ token: 'never-issued', password: 'new-password-123' }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_RESET_TOKEN' } });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('rejects an already-used token with 401 RESET_TOKEN_ALREADY_USED', async () => {
    tx.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });
    tx.passwordResetToken.findUnique.mockResolvedValue({
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      service.resetPassword({ token: RAW_TOKEN, password: 'new-password-123' }),
    ).rejects.toMatchObject({ response: { code: 'RESET_TOKEN_ALREADY_USED' } });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('rejects an expired token with 401 RESET_TOKEN_EXPIRED', async () => {
    tx.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });
    tx.passwordResetToken.findUnique.mockResolvedValue({
      usedAt: null,
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(
      service.resetPassword({ token: RAW_TOKEN, password: 'new-password-123' }),
    ).rejects.toMatchObject({ response: { code: 'RESET_TOKEN_EXPIRED' } });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('a second concurrent claim on the same token loses the race (updateMany matches 0) and is rejected — single success', async () => {
    // Simulates two callers racing the SAME atomic updateMany: the second
    // one to reach it finds usedAt already set by the first, matches 0 rows.
    // The first successful reset makes TWO updateMany calls on this table
    // (the claim, then "invalidate every other live token") before the
    // second caller's claim attempt (the 3rd call) loses the race.
    tx.passwordResetToken.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    tx.passwordResetToken.findUniqueOrThrow.mockResolvedValue({ id: 't', userId: 'user-1' });
    tx.passwordResetToken.findUnique.mockResolvedValue({
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    tx.user.findUnique.mockResolvedValue(makeUser());

    const first = await service.resetPassword({ token: RAW_TOKEN, password: 'new-password-123' });
    expect(first.message).toMatch(/reset/i);

    await expect(
      service.resetPassword({ token: RAW_TOKEN, password: 'another-password-456' }),
    ).rejects.toMatchObject({ response: { code: 'RESET_TOKEN_ALREADY_USED' } });
    expect(tx.user.update).toHaveBeenCalledTimes(1);
  });

  it('refuses a claimed token whose user was deleted after issuance — still burns the token, never reveals why', async () => {
    tx.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
    tx.passwordResetToken.findUniqueOrThrow.mockResolvedValue({ id: 't', userId: 'user-1' });
    tx.user.findUnique.mockResolvedValue(makeUser({ deletedAt: new Date() }));

    await expect(
      service.resetPassword({ token: RAW_TOKEN, password: 'new-password-123' }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_RESET_TOKEN' } });
    expect(tx.user.update).not.toHaveBeenCalled();
    // The claim itself already ran (token consumed) even though the reset didn't happen.
    expect(tx.passwordResetToken.updateMany).toHaveBeenCalledTimes(1);
  });

  it('refuses a claimed token for a user with no local password (federated-only) — defense in depth', async () => {
    tx.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
    tx.passwordResetToken.findUniqueOrThrow.mockResolvedValue({ id: 't', userId: 'user-1' });
    tx.user.findUnique.mockResolvedValue(makeUser({ passwordHash: null, firebaseUid: 'uid-1' }));

    await expect(
      service.resetPassword({ token: RAW_TOKEN, password: 'new-password-123' }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_RESET_TOKEN' } });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('never reactivates a deleted account and never touches role', async () => {
    tx.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
    tx.passwordResetToken.findUniqueOrThrow.mockResolvedValue({ id: 't', userId: 'user-1' });
    tx.user.findUnique.mockResolvedValue(makeUser());

    await service.resetPassword({ token: RAW_TOKEN, password: 'new-password-123' });

    const updateData = tx.user.update.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty('deletedAt');
    expect(updateData).not.toHaveProperty('role');
  });

  it('does not return an access/refresh token pair — never auto-logs-in', async () => {
    tx.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
    tx.passwordResetToken.findUniqueOrThrow.mockResolvedValue({ id: 't', userId: 'user-1' });
    tx.user.findUnique.mockResolvedValue(makeUser());

    const result = await service.resetPassword({ token: RAW_TOKEN, password: 'new-password-123' });

    expect(result).not.toHaveProperty('accessToken');
    expect(result).not.toHaveProperty('refreshToken');
  });

  it('rejects with UnauthorizedException instances (401), never leaking internals', async () => {
    tx.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });
    tx.passwordResetToken.findUnique.mockResolvedValue(null);

    await expect(
      service.resetPassword({ token: 'bogus', password: 'new-password-123' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
