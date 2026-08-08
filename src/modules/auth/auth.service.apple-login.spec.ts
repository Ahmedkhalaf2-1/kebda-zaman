import { User, UserRole } from '@prisma/client';
jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn() }));
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from './password.service';
import { TokenService, RequestMeta } from './token.service';
import { BruteForceService } from './brute-force.service';
import { GoogleAuthService, VerifiedFirebaseIdentity } from './google-auth.service';

const META: RequestMeta = { ip: '127.0.0.1', userAgent: 'jest' };
const APPLE_IDENTITY: VerifiedFirebaseIdentity = {
  uid: 'apple-firebase-uid',
  email: 'private@privaterelay.appleid.com',
  name: 'Apple Customer',
  signInProvider: 'apple.com',
};

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: APPLE_IDENTITY.email,
    passwordHash: null,
    firebaseUid: APPLE_IDENTITY.uid,
    fullName: 'Apple Customer',
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

describe('AuthService.appleLogin', () => {
  it('verifies the Apple Firebase token and returns the normal app session', async () => {
    const created = makeUser();
    const prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
        create: jest.fn().mockResolvedValue(created),
      },
    };
    const tokenService = {
      issueTokenPair: jest.fn().mockResolvedValue({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
    };
    const firebaseAuth = {
      verifyApple: jest.fn().mockResolvedValue(APPLE_IDENTITY),
    };
    const service = new AuthService(
      prisma as unknown as PrismaService,
      {} as PasswordService,
      tokenService as unknown as TokenService,
      {} as BruteForceService,
      firebaseAuth as unknown as GoogleAuthService,
    );

    const result = await service.appleLogin({ firebaseIdToken: 'apple-token' }, META);

    expect(firebaseAuth.verifyApple).toHaveBeenCalledWith('apple-token');
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        email: APPLE_IDENTITY.email,
        fullName: APPLE_IDENTITY.name,
        avatarUrl: null,
        firebaseUid: APPLE_IDENTITY.uid,
        role: UserRole.CUSTOMER,
        isGuest: false,
      },
    });
    expect(result).toMatchObject({
      user: { id: 'user-1', role: UserRole.CUSTOMER },
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
  });
});
