import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';

function makePrincipal(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: 'user-1', role: UserRole.CUSTOMER, isGuest: false, jti: 'jti-1', ...overrides };
}

describe('AuthController.deleteAccount — route wiring', () => {
  // The global JwtAccessGuard only skips routes marked @Public(); this route
  // isn't, so an unauthenticated request is rejected before the handler runs.
  it('is not marked @Public — the global JwtAccessGuard rejects unauthenticated requests', () => {
    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, AuthController.prototype.deleteAccount),
    ).toBeUndefined();
  });

  // The global RolesGuard reads this metadata to reject ADMIN/CASHIER principals.
  it('is restricted to CUSTOMER via @Roles', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AuthController.prototype.deleteAccount)).toEqual([
      'CUSTOMER',
    ]);
  });
});

describe('AuthController.deleteAccount — handler behavior', () => {
  let authService: { deleteAccount: jest.Mock };

  beforeEach(() => {
    authService = { deleteAccount: jest.fn().mockResolvedValue(undefined) };
  });

  function makeController(): AuthController {
    return new AuthController(authService as unknown as AuthService);
  }

  it('rejects a guest principal with 403 GUEST_NOT_ELIGIBLE and never calls the service', async () => {
    const controller = makeController();
    const guest = makePrincipal({ isGuest: true });

    await expect(controller.deleteAccount(guest)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.deleteAccount(guest)).rejects.toMatchObject({
      response: { code: 'GUEST_NOT_ELIGIBLE' },
    });
    expect(authService.deleteAccount).not.toHaveBeenCalled();
  });

  it("deletes the caller's own account — the id always comes from the verified principal, never a param/body", async () => {
    const controller = makeController();
    const principal = makePrincipal({ id: 'the-caller-id' });

    await controller.deleteAccount(principal);

    expect(authService.deleteAccount).toHaveBeenCalledTimes(1);
    expect(authService.deleteAccount).toHaveBeenCalledWith('the-caller-id');
  });
});
