import { Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { App } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { GoogleAuthService } from './google-auth.service';

jest.mock('firebase-admin/auth', () => ({
  getAuth: jest.fn(),
}));

const mockedGetAuth = jest.mocked(getAuth);

function decodedToken(overrides: Partial<DecodedIdToken> = {}): DecodedIdToken {
  return {
    uid: 'firebase-uid-123',
    email: 'Customer@Example.com',
    email_verified: true,
    name: 'Jane Doe',
    picture: 'https://example.com/photo.jpg',
    firebase: { sign_in_provider: 'google.com', identities: {} },
    aud: 'keebda-zaman',
    auth_time: 0,
    exp: 0,
    iat: 0,
    iss: '',
    sub: '',
    ...overrides,
  } as DecodedIdToken;
}

describe('GoogleAuthService.verify', () => {
  let verifyIdToken: jest.Mock;

  beforeEach(() => {
    verifyIdToken = jest.fn();
    mockedGetAuth.mockReturnValue({ verifyIdToken } as unknown as ReturnType<typeof getAuth>);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeService(firebaseApp: App | null = {} as App): GoogleAuthService {
    return new GoogleAuthService(firebaseApp);
  }

  it('valid token: returns the verified identity, email lower-cased', async () => {
    verifyIdToken.mockResolvedValue(decodedToken());
    const service = makeService();

    const identity = await service.verify('a-valid-token');

    expect(identity).toEqual({
      uid: 'firebase-uid-123',
      email: 'customer@example.com',
      name: 'Jane Doe',
      picture: 'https://example.com/photo.jpg',
      signInProvider: 'google.com',
    });
  });

  it('never passes client-controllable fields through untouched — email is normalized', async () => {
    verifyIdToken.mockResolvedValue(decodedToken({ email: '  Weird.Case@EXAMPLE.com  '.trim() }));
    const service = makeService();

    const identity = await service.verify('token');

    expect(identity.email).toBe('weird.case@example.com');
  });

  it('invalid/malformed token: verifyIdToken rejects -> generic 401', async () => {
    verifyIdToken.mockRejectedValue(new Error('Firebase ID token has invalid signature'));
    const service = makeService();

    await expect(service.verify('garbage')).rejects.toThrow(UnauthorizedException);
    await expect(service.verify('garbage')).rejects.toMatchObject({
      response: { code: 'INVALID_GOOGLE_TOKEN', message: 'Invalid Google authentication token' },
    });
  });

  it('expired token: verifyIdToken rejects -> generic 401 (same as any other invalid token)', async () => {
    verifyIdToken.mockRejectedValue(new Error('Firebase ID token has expired'));
    const service = makeService();

    await expect(service.verify('expired')).rejects.toThrow(UnauthorizedException);
  });

  it('missing email on an otherwise-valid token: 401', async () => {
    verifyIdToken.mockResolvedValue(decodedToken({ email: undefined }));
    const service = makeService();

    await expect(service.verify('token')).rejects.toMatchObject({
      response: { code: 'INVALID_GOOGLE_TOKEN' },
    });
  });

  it('email present but not verified: 401', async () => {
    verifyIdToken.mockResolvedValue(decodedToken({ email_verified: false }));
    const service = makeService();

    await expect(service.verify('token')).rejects.toMatchObject({
      response: { code: 'INVALID_GOOGLE_TOKEN' },
    });
  });

  it('sign_in_provider "google.com": succeeds', async () => {
    verifyIdToken.mockResolvedValue(
      decodedToken({ firebase: { sign_in_provider: 'google.com', identities: {} } }),
    );
    const service = makeService();

    const identity = await service.verify('token');

    expect(identity.signInProvider).toBe('google.com');
  });

  it('verifyApple accepts only an apple.com Firebase provider token', async () => {
    verifyIdToken.mockResolvedValue(
      decodedToken({ firebase: { sign_in_provider: 'apple.com', identities: {} } }),
    );
    const service = makeService();

    const identity = await service.verifyApple('apple-token');

    expect(identity.signInProvider).toBe('apple.com');
    expect(identity.email).toBe('customer@example.com');
  });

  it('verifyApple rejects a Google token with the Apple-specific error code', async () => {
    verifyIdToken.mockResolvedValue(decodedToken());
    const service = makeService();

    await expect(service.verifyApple('google-token')).rejects.toMatchObject({
      response: { code: 'INVALID_APPLE_TOKEN', message: 'Invalid Apple authentication token' },
    });
  });

  it('sign_in_provider "password": rejected with generic 401', async () => {
    verifyIdToken.mockResolvedValue(
      decodedToken({ firebase: { sign_in_provider: 'password', identities: {} } }),
    );
    const service = makeService();

    await expect(service.verify('token')).rejects.toMatchObject({
      response: { code: 'INVALID_GOOGLE_TOKEN', message: 'Invalid Google authentication token' },
    });
  });

  it('sign_in_provider "anonymous": rejected with generic 401', async () => {
    verifyIdToken.mockResolvedValue(
      decodedToken({ firebase: { sign_in_provider: 'anonymous', identities: {} } }),
    );
    const service = makeService();

    await expect(service.verify('token')).rejects.toMatchObject({
      response: { code: 'INVALID_GOOGLE_TOKEN' },
    });
  });

  it('missing sign_in_provider: rejected with generic 401', async () => {
    verifyIdToken.mockResolvedValue(decodedToken({ firebase: undefined }));
    const service = makeService();

    await expect(service.verify('token')).rejects.toMatchObject({
      response: { code: 'INVALID_GOOGLE_TOKEN' },
    });
  });

  it('Firebase Admin not configured (no credentials): 401, does not call verifyIdToken', async () => {
    const service = makeService(null);

    await expect(service.verify('token')).rejects.toThrow(UnauthorizedException);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('never logs the raw token value on failure', async () => {
    const rawToken = 'super-secret-firebase-id-token-value';
    verifyIdToken.mockRejectedValue(new Error('invalid signature'));
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = makeService();

    await expect(service.verify(rawToken)).rejects.toThrow(UnauthorizedException);

    for (const call of warnSpy.mock.calls) {
      for (const arg of call) {
        const serialized = typeof arg === 'string' ? arg : JSON.stringify(arg);
        expect(serialized).not.toContain(rawToken);
      }
    }
  });
});

describe('GoogleAuthService.deleteUser', () => {
  let deleteUser: jest.Mock;

  beforeEach(() => {
    deleteUser = jest.fn();
    mockedGetAuth.mockReturnValue({ deleteUser } as unknown as ReturnType<typeof getAuth>);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeService(firebaseApp: App | null = {} as App): GoogleAuthService {
    return new GoogleAuthService(firebaseApp);
  }

  it('calls the Admin SDK with the given uid and resolves', async () => {
    deleteUser.mockResolvedValue(undefined);
    const service = makeService();

    await expect(service.deleteUser('firebase-uid-123')).resolves.toBeUndefined();
    expect(deleteUser).toHaveBeenCalledWith('firebase-uid-123');
  });

  it('auth/user-not-found is treated as already deleted — resolves without throwing', async () => {
    deleteUser.mockRejectedValue(
      Object.assign(new Error('no user record'), { code: 'auth/user-not-found' }),
    );
    const service = makeService();

    await expect(service.deleteUser('already-gone')).resolves.toBeUndefined();
  });

  it('an unexpected Firebase failure is surfaced explicitly, never swallowed', async () => {
    deleteUser.mockRejectedValue(new Error('internal Firebase error'));
    const service = makeService();

    await expect(service.deleteUser('firebase-uid-123')).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(service.deleteUser('firebase-uid-123')).rejects.toMatchObject({
      response: { code: 'FIREBASE_DELETE_FAILED' },
    });
  });

  it('Firebase Admin not configured: throws explicitly, never calls the SDK', async () => {
    const service = makeService(null);

    await expect(service.deleteUser('firebase-uid-123')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(deleteUser).not.toHaveBeenCalled();
  });
});
