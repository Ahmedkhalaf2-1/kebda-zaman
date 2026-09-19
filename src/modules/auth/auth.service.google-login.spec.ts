import { UnauthorizedException } from '@nestjs/common';
import { Prisma, User, UserRole } from '@prisma/client';
// AuthService statically imports GoogleAuthService, which imports
// firebase-admin/auth — mocked here so this unit test never pulls in the
// real Admin SDK (it transitively depends on ESM-only packages Jest can't
// parse without this). This suite mocks GoogleAuthService itself anyway.
jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn() }));
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from './password.service';
import { TokenService, RequestMeta } from './token.service';
import { BruteForceService } from './brute-force.service';
import { PasswordResetThrottleService } from './password-reset-throttle.service';
import { GoogleAuthService, VerifiedGoogleIdentity } from './google-auth.service';
import { EmailService } from '../email/email.service';
import { ConfigService } from '@nestjs/config';

const META: RequestMeta = { ip: '127.0.0.1', userAgent: 'jest' };

const IDENTITY: VerifiedGoogleIdentity = {
  uid: 'firebase-uid-abc',
  email: 'customer@example.com',
  name: 'Jane Doe',
  picture: 'https://example.com/photo.jpg',
  signInProvider: 'google.com',
};

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'customer@example.com',
    passwordHash: null,
    firebaseUid: null,
    fullName: 'Jane Doe',
    phone: null,
    avatarUrl: null,
    role: UserRole.CUSTOMER,
    isGuest: false,
    locale: 'en',
    onboardingCompleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as User;
}

describe('AuthService.googleLogin — account resolution', () => {
  let prisma: {
    user: { findFirst: jest.Mock; update: jest.Mock; create: jest.Mock };
  };
  let tokenService: { issueTokenPair: jest.Mock };
  let googleAuthService: { verify: jest.Mock };

  beforeEach(() => {
    prisma = {
      user: {
        findFirst: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      },
    };
    tokenService = {
      issueTokenPair: jest.fn().mockResolvedValue({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
    };
    googleAuthService = { verify: jest.fn().mockResolvedValue(IDENTITY) };
  });

  function makeService(): AuthService {
    return new AuthService(
      prisma as unknown as PrismaService,
      {} as PasswordService,
      tokenService as unknown as TokenService,
      {} as BruteForceService,
      {} as PasswordResetThrottleService,
      googleAuthService as unknown as GoogleAuthService,
      {} as EmailService,
      {} as ConfigService,
    );
  }

  it('new user: creates a CUSTOMER account and returns the normal login response shape', async () => {
    prisma.user.findFirst.mockResolvedValue(null); // neither uid nor email match
    const created = makeUser({ id: 'new-user', firebaseUid: IDENTITY.uid });
    prisma.user.create.mockResolvedValue(created);
    const service = makeService();

    const result = await service.googleLogin({ firebaseIdToken: 'tok' }, META);

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        email: IDENTITY.email,
        fullName: IDENTITY.name,
        avatarUrl: IDENTITY.picture,
        firebaseUid: IDENTITY.uid,
        role: UserRole.CUSTOMER,
        isGuest: false,
      },
    });
    expect(result.user.role).toBe(UserRole.CUSTOMER);
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBe('refresh-token');
    expect(tokenService.issueTokenPair).toHaveBeenCalledWith(created, META);
  });

  it('existing firebaseUid: returns that user directly, never creates or updates', async () => {
    const existing = makeUser({ id: 'existing-linked', firebaseUid: IDENTITY.uid });
    prisma.user.findFirst.mockResolvedValueOnce(existing); // byUid hit
    const service = makeService();

    const result = await service.googleLogin({ firebaseIdToken: 'tok' }, META);

    expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { firebaseUid: IDENTITY.uid, deletedAt: null },
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(result.user.id).toBe('existing-linked');
  });

  it('existing email/password account with the same verified email is linked, not duplicated', async () => {
    const existing = makeUser({
      id: 'password-user',
      passwordHash: '$argon2id$v=19$...',
      firebaseUid: null,
    });
    prisma.user.findFirst
      .mockResolvedValueOnce(null) // byUid miss
      .mockResolvedValueOnce(existing); // byEmail hit
    const linked = { ...existing, firebaseUid: IDENTITY.uid };
    prisma.user.update.mockResolvedValue(linked);
    const service = makeService();

    await service.googleLogin({ firebaseIdToken: 'tok' }, META);

    expect(prisma.user.findFirst).toHaveBeenNthCalledWith(2, {
      where: { email: { equals: IDENTITY.email, mode: 'insensitive' }, deletedAt: null },
    });
    // Only firebaseUid is written — passwordHash/fullName/avatarUrl are untouched.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'password-user' },
      data: { firebaseUid: IDENTITY.uid },
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('existing password hash is never read or rewritten by the linking path', async () => {
    const existing = makeUser({ id: 'password-user', passwordHash: 'original-hash' });
    prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    prisma.user.update.mockResolvedValue({ ...existing, firebaseUid: IDENTITY.uid });
    const service = makeService();

    await service.googleLogin({ firebaseIdToken: 'tok' }, META);

    const updateCall = prisma.user.update.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty('passwordHash');
  });

  it('repeated Google login for the same identity does not create a duplicate user', async () => {
    prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const created = makeUser({ id: 'new-user', firebaseUid: IDENTITY.uid });
    prisma.user.create.mockResolvedValue(created);
    const service = makeService();
    await service.googleLogin({ firebaseIdToken: 'tok' }, META);
    expect(prisma.user.create).toHaveBeenCalledTimes(1);

    // Second login: the row now exists and is found by firebaseUid.
    prisma.user.findFirst.mockReset();
    prisma.user.findFirst.mockResolvedValueOnce(created);
    await service.googleLogin({ firebaseIdToken: 'tok' }, META);

    expect(prisma.user.create).toHaveBeenCalledTimes(1);
  });

  it('invalid token: propagates the 401 from GoogleAuthService and never touches Prisma', async () => {
    const authError = new UnauthorizedException({
      message: 'Invalid Google authentication token',
      code: 'INVALID_GOOGLE_TOKEN',
    });
    googleAuthService.verify.mockRejectedValue(authError);
    const service = makeService();

    await expect(service.googleLogin({ firebaseIdToken: 'bad' }, META)).rejects.toBe(authError);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('expired token: propagates the same 401 shape, never touches Prisma', async () => {
    const authError = new UnauthorizedException({
      message: 'Invalid Google authentication token',
      code: 'INVALID_GOOGLE_TOKEN',
    });
    googleAuthService.verify.mockRejectedValue(authError);
    const service = makeService();

    await expect(service.googleLogin({ firebaseIdToken: 'expired' }, META)).rejects.toBe(authError);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('a soft-deleted account matching the uid/email is invisible — Google login never reactivates it', async () => {
    // Both lookups filter deletedAt: null, so a deleted row never surfaces here.
    prisma.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const created = makeUser({ id: 'fresh-account', firebaseUid: IDENTITY.uid });
    prisma.user.create.mockResolvedValue(created);
    const service = makeService();

    const result = await service.googleLogin({ firebaseIdToken: 'tok' }, META);

    expect(prisma.user.findFirst.mock.calls[0][0].where.deletedAt).toBeNull();
    expect(prisma.user.findFirst.mock.calls[1][0].where.deletedAt).toBeNull();
    expect(result.user.id).toBe('fresh-account');
  });

  it('new Google user always receives CUSTOMER role, even if the identity object were tampered with', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockImplementation(({ data }) => Promise.resolve(makeUser({ ...data })));
    googleAuthService.verify.mockResolvedValue({
      ...IDENTITY,
      // Not part of VerifiedGoogleIdentity — proves the service ignores it.
      role: 'ADMIN',
    } as VerifiedGoogleIdentity);
    const service = makeService();

    await service.googleLogin({ firebaseIdToken: 'tok' }, META);

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: UserRole.CUSTOMER }) }),
    );
  });

  it('unique-constraint race on create: re-resolves to the winning row instead of throwing', async () => {
    prisma.user.findFirst
      .mockResolvedValueOnce(null) // byUid miss (first pass)
      .mockResolvedValueOnce(null) // byEmail miss (first pass)
      .mockResolvedValueOnce(makeUser({ id: 'raced-in-user', firebaseUid: IDENTITY.uid })); // re-resolve after conflict
    const raceError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '6.2.0',
    });
    prisma.user.create.mockRejectedValue(raceError);
    const service = makeService();

    const result = await service.googleLogin({ firebaseIdToken: 'tok' }, META);

    expect(result.user.id).toBe('raced-in-user');
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
  });
});
