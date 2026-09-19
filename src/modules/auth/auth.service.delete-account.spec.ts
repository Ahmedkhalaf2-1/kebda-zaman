import { ConflictException } from '@nestjs/common';
// AuthService statically imports GoogleAuthService, which imports
// firebase-admin/auth — mocked here so this unit test never pulls in the
// real Admin SDK (it transitively depends on ESM-only packages Jest can't
// parse without this). This suite mocks GoogleAuthService itself anyway.
jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn() }));
import { User, UserRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { BruteForceService } from './brute-force.service';
import { PasswordResetThrottleService } from './password-reset-throttle.service';
import { GoogleAuthService } from './google-auth.service';
import { EmailService } from '../email/email.service';
import { ConfigService } from '@nestjs/config';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'customer@example.com',
    passwordHash: '$argon2id$v=19$...',
    firebaseUid: null,
    fullName: 'Jane Doe',
    phone: '+201234567890',
    avatarUrl: 'https://example.com/avatar.jpg',
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

describe('AuthService.deleteAccount', () => {
  let prisma: {
    user: { findFirst: jest.Mock; update: jest.Mock };
    order: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    address: { deleteMany: jest.Mock };
    favorite: { deleteMany: jest.Mock };
    loyaltyAccount: { deleteMany: jest.Mock };
    deviceToken: { deleteMany: jest.Mock };
    refreshToken: { deleteMany: jest.Mock };
    cart: { deleteMany: jest.Mock };
    order: { updateMany: jest.Mock };
    user: { update: jest.Mock };
  };
  let googleAuthService: { deleteUser: jest.Mock };
  const callOrder: string[] = [];

  beforeEach(() => {
    callOrder.length = 0;

    tx = {
      address: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      favorite: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      loyaltyAccount: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      deviceToken: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      refreshToken: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      cart: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      order: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      user: { update: jest.fn().mockResolvedValue(undefined) },
    };

    prisma = {
      user: { findFirst: jest.fn(), update: jest.fn() },
      order: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        callOrder.push('transaction');
        return callback(tx);
      }),
    };

    googleAuthService = {
      deleteUser: jest.fn().mockImplementation(async () => {
        callOrder.push('firebase-delete');
      }),
    };
  });

  function makeService(): AuthService {
    return new AuthService(
      prisma as unknown as PrismaService,
      {} as PasswordService,
      {} as TokenService,
      {} as BruteForceService,
      {} as PasswordResetThrottleService,
      googleAuthService as unknown as GoogleAuthService,
      {} as EmailService,
      {} as ConfigService,
    );
  }

  it('already-deleted / nonexistent account: resolves silently, no order check, no transaction, no Firebase call', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const service = makeService();

    await expect(service.deleteAccount('gone')).resolves.toBeUndefined();

    expect(prisma.order.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(googleAuthService.deleteUser).not.toHaveBeenCalled();
  });

  it('active order (e.g. PREPARING): throws 409 ACTIVE_ORDER_EXISTS, never touches Firebase or the transaction', async () => {
    prisma.user.findFirst.mockResolvedValue(makeUser());
    prisma.order.findFirst.mockResolvedValue({ id: 'order-1' });
    const service = makeService();

    await expect(service.deleteAccount('user-1')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.deleteAccount('user-1')).rejects.toMatchObject({
      response: { code: 'ACTIVE_ORDER_EXISTS' },
    });
    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: { notIn: ['DELIVERED', 'PICKED_UP', 'CANCELLED'] } },
      select: { id: true },
    });
    expect(googleAuthService.deleteUser).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('only DELIVERED/PICKED_UP/CANCELLED orders (all terminal): deletion proceeds', async () => {
    prisma.user.findFirst.mockResolvedValue(makeUser());
    prisma.order.findFirst.mockResolvedValue(null); // the notIn-terminal query finds nothing active
    const service = makeService();

    await expect(service.deleteAccount('user-1')).resolves.toBeUndefined();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('no firebaseUid: Firebase is never called, only the local transaction runs', async () => {
    prisma.user.findFirst.mockResolvedValue(makeUser({ firebaseUid: null }));
    const service = makeService();

    await service.deleteAccount('user-1');

    expect(googleAuthService.deleteUser).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('firebaseUid present: Firebase deletion is called with that uid, BEFORE the local transaction', async () => {
    prisma.user.findFirst.mockResolvedValue(makeUser({ firebaseUid: 'firebase-uid-abc' }));
    const service = makeService();

    await service.deleteAccount('user-1');

    expect(googleAuthService.deleteUser).toHaveBeenCalledWith('firebase-uid-abc');
    expect(callOrder).toEqual(['firebase-delete', 'transaction']);
  });

  it('Firebase user-not-found is handled inside GoogleAuthService (resolves, not rejects) — deletion still proceeds', async () => {
    // GoogleAuthService.deleteUser itself swallows 'auth/user-not-found' and
    // resolves — from AuthService's perspective this looks identical to a
    // normal successful deletion, so the transaction must still run.
    prisma.user.findFirst.mockResolvedValue(makeUser({ firebaseUid: 'already-gone-uid' }));
    googleAuthService.deleteUser.mockResolvedValue(undefined);
    const service = makeService();

    await expect(service.deleteAccount('user-1')).resolves.toBeUndefined();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('unexpected Firebase failure: propagates, the local transaction never runs (no silent success)', async () => {
    prisma.user.findFirst.mockResolvedValue(makeUser({ firebaseUid: 'firebase-uid-abc' }));
    const firebaseError = new Error('Firebase deletion failed');
    googleAuthService.deleteUser.mockRejectedValue(firebaseError);
    const service = makeService();

    await expect(service.deleteAccount('user-1')).rejects.toBe(firebaseError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('deletes addresses, favorites, loyalty, device tokens, refresh tokens and the cart', async () => {
    prisma.user.findFirst.mockResolvedValue(makeUser());
    const service = makeService();

    await service.deleteAccount('user-1');

    expect(tx.address.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(tx.favorite.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(tx.loyaltyAccount.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(tx.deviceToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(tx.cart.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });

  it('redacts the delivery-address snapshot on retained DELIVERY orders only — orders are never deleted', async () => {
    prisma.user.findFirst.mockResolvedValue(makeUser());
    const service = makeService();

    await service.deleteAccount('user-1');

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', deliveryMethod: 'DELIVERY' },
      data: {
        deliveryAddressJson: {
          redacted: true,
          title: null,
          street: null,
          building: null,
          floor: null,
          apartment: null,
          city: null,
          latitude: null,
          longitude: null,
        },
      },
    });
  });

  it('anonymizes the User row and marks it deleted, instead of hard-deleting it', async () => {
    prisma.user.findFirst.mockResolvedValue(makeUser({ id: 'user-1' }));
    const service = makeService();

    const before = Date.now();
    await service.deleteAccount('user-1');

    expect(tx.user.update).toHaveBeenCalledTimes(1);
    const call = tx.user.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'user-1' });
    expect(call.data).toMatchObject({
      email: null,
      passwordHash: null,
      firebaseUid: null,
      fullName: 'Deleted User',
      phone: null,
      avatarUrl: null,
    });
    expect(call.data.deletedAt).toBeInstanceOf(Date);
    expect((call.data.deletedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });
});
