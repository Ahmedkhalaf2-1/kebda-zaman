import { Logger, UnauthorizedException } from '@nestjs/common';
// AuthService statically imports GoogleAuthService, which imports
// firebase-admin/auth — mocked here so this unit test never pulls in the
// real Admin SDK (it transitively depends on ESM-only packages Jest can't
// parse without this).
jest.mock('firebase-admin/auth', () => ({ getAuth: jest.fn() }));
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from './password.service';
import { TokenService, RequestMeta } from './token.service';
import { BruteForceService } from './brute-force.service';
import { GoogleAuthService } from './google-auth.service';

const META: RequestMeta = { ip: '127.0.0.1', userAgent: 'jest' };

describe('AuthService.refresh — device deactivation on rejected session refresh', () => {
  let prisma: { deviceToken: { updateMany: jest.Mock } };
  let tokenService: { rotateRefreshToken: jest.Mock };
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    prisma = {
      deviceToken: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    tokenService = {
      rotateRefreshToken: jest.fn(),
    };
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    jest.restoreAllMocks();
  });

  function makeService(): AuthService {
    return new AuthService(
      prisma as unknown as PrismaService,
      {} as PasswordService,
      tokenService as unknown as TokenService,
      {} as BruteForceService,
      {} as GoogleAuthService,
    );
  }

  it('successful refresh with deviceToken: returns rotated tokens and does not touch DeviceToken', async () => {
    tokenService.rotateRefreshToken.mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });
    const service = makeService();

    const result = await service.refresh('raw-refresh', META, 'device-abc');

    expect(result).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    expect(prisma.deviceToken.updateMany).not.toHaveBeenCalled();
  });

  it('expired refresh token with deviceToken: rethrows original 401 and deactivates the exact device', async () => {
    const expiredError = new UnauthorizedException({
      message: 'Refresh token expired',
      code: 'REFRESH_TOKEN_EXPIRED',
    });
    tokenService.rotateRefreshToken.mockRejectedValue(expiredError);
    const service = makeService();

    await expect(service.refresh('raw-refresh', META, 'device-abc')).rejects.toBe(expiredError);
    expect(prisma.deviceToken.updateMany).toHaveBeenCalledWith({
      where: { token: 'device-abc', isActive: true },
      data: { isActive: false },
    });
  });

  it('reused refresh token with deviceToken: original REFRESH_TOKEN_REUSED error remains, device deactivated', async () => {
    const reuseError = new UnauthorizedException({
      message: 'Refresh token reuse detected; all sessions in this lineage were revoked',
      code: 'REFRESH_TOKEN_REUSED',
    });
    tokenService.rotateRefreshToken.mockRejectedValue(reuseError);
    const service = makeService();

    await expect(service.refresh('raw-refresh', META, 'device-abc')).rejects.toBe(reuseError);
    // The family-revocation itself lives inside TokenService.rotateRefreshToken,
    // which is mocked here — this test only asserts AuthService's own behavior
    // around the error it receives.
    expect(prisma.deviceToken.updateMany).toHaveBeenCalledWith({
      where: { token: 'device-abc', isActive: true },
      data: { isActive: false },
    });
    expect((reuseError.getResponse() as { code: string }).code).toBe('REFRESH_TOKEN_REUSED');
  });

  it('invalid refresh token with deviceToken: original INVALID_REFRESH_TOKEN response remains; updateMany targets only supplied token', async () => {
    const invalidError = new UnauthorizedException({
      message: 'Invalid refresh token',
      code: 'INVALID_REFRESH_TOKEN',
    });
    tokenService.rotateRefreshToken.mockRejectedValue(invalidError);
    const service = makeService();

    await expect(service.refresh('raw-refresh', META, 'device-xyz')).rejects.toBe(invalidError);
    expect(prisma.deviceToken.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.deviceToken.updateMany).toHaveBeenCalledWith({
      where: { token: 'device-xyz', isActive: true },
      data: { isActive: false },
    });
  });

  it('rejected refresh WITHOUT deviceToken: no DeviceToken update at all; original 401 remains', async () => {
    const expiredError = new UnauthorizedException({
      message: 'Refresh token expired',
      code: 'REFRESH_TOKEN_EXPIRED',
    });
    tokenService.rotateRefreshToken.mockRejectedValue(expiredError);
    const service = makeService();

    await expect(service.refresh('raw-refresh', META)).rejects.toBe(expiredError);
    expect(prisma.deviceToken.updateMany).not.toHaveBeenCalled();
  });

  it('device cleanup updateMany throws: original UnauthorizedException is still thrown, not the cleanup error', async () => {
    const authError = new UnauthorizedException({
      message: 'Invalid refresh token',
      code: 'INVALID_REFRESH_TOKEN',
    });
    tokenService.rotateRefreshToken.mockRejectedValue(authError);
    prisma.deviceToken.updateMany.mockRejectedValue(new Error('db unavailable'));
    const service = makeService();

    await expect(service.refresh('raw-refresh', META, 'device-abc')).rejects.toBe(authError);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('non-auth exception during rotate: DeviceToken untouched, error rethrown unchanged', async () => {
    const dbError = new Error('connection reset');
    tokenService.rotateRefreshToken.mockRejectedValue(dbError);
    const service = makeService();

    await expect(service.refresh('raw-refresh', META, 'device-abc')).rejects.toBe(dbError);
    expect(prisma.deviceToken.updateMany).not.toHaveBeenCalled();
  });

  it('does not modify a different device token: updateMany where-clause targets only the supplied token', async () => {
    const expiredError = new UnauthorizedException({
      message: 'Refresh token expired',
      code: 'REFRESH_TOKEN_EXPIRED',
    });
    tokenService.rotateRefreshToken.mockRejectedValue(expiredError);
    const service = makeService();

    await expect(
      service.refresh('raw-refresh', META, 'device-this-one'),
    ).rejects.toBe(expiredError);

    expect(prisma.deviceToken.updateMany).toHaveBeenCalledTimes(1);
    const call = prisma.deviceToken.updateMany.mock.calls[0][0];
    expect(call.where.token).toBe('device-this-one');
    expect(call.where.token).not.toBe('device-other-one');
  });

  it('never logs raw token values', async () => {
    const expiredError = new UnauthorizedException({
      message: 'Refresh token expired',
      code: 'REFRESH_TOKEN_EXPIRED',
    });
    tokenService.rotateRefreshToken.mockRejectedValue(expiredError);
    prisma.deviceToken.updateMany.mockRejectedValue(new Error('db unavailable'));
    const service = makeService();

    const rawRefreshToken = 'super-secret-refresh-token-value';
    const rawDeviceToken = 'super-secret-device-token-value';

    await expect(
      service.refresh(rawRefreshToken, META, rawDeviceToken),
    ).rejects.toBe(expiredError);

    for (const call of warnSpy.mock.calls) {
      for (const arg of call) {
        const serialized = typeof arg === 'string' ? arg : JSON.stringify(arg);
        expect(serialized).not.toContain(rawRefreshToken);
        expect(serialized).not.toContain(rawDeviceToken);
      }
    }
  });
});
