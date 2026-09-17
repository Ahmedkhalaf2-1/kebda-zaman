import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ActiveDriverGuard } from './active-driver.guard';
import { PrismaService } from '../../prisma/prisma.service';

function contextWithUser(user?: { id: string; role: string }): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

describe('ActiveDriverGuard', () => {
  let findFirst: jest.Mock;
  let guard: ActiveDriverGuard;

  beforeEach(() => {
    findFirst = jest.fn();
    guard = new ActiveDriverGuard({ user: { findFirst } } as unknown as PrismaService);
  });

  it('passes through (no DB check) when there is no principal', async () => {
    await expect(guard.canActivate(contextWithUser(undefined))).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('passes through (no DB check) for a non-DRIVER principal', async () => {
    await expect(
      guard.canActivate(contextWithUser({ id: 'admin-1', role: 'ADMIN' })),
    ).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('allows an active driver', async () => {
    findFirst.mockResolvedValue({ id: 'driver-1' });
    await expect(
      guard.canActivate(contextWithUser({ id: 'driver-1', role: 'DRIVER' })),
    ).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'driver-1', role: 'DRIVER', deletedAt: null },
      select: { id: true },
    });
  });

  it('rejects a deactivated driver even with a still-valid access token', async () => {
    findFirst.mockResolvedValue(null);
    await expect(
      guard.canActivate(contextWithUser({ id: 'driver-1', role: 'DRIVER' })),
    ).rejects.toThrow(UnauthorizedException);
  });
});
