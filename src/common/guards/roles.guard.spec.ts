import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { RolesGuard } from './roles.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/**
 * Phase 2 does not yet expose any business route restricted with `@Roles()`
 * (no admin-only CRUD exists before Phase 3+), so the CUSTOMER-vs-ADMIN
 * branching of the shared RBAC infrastructure is verified directly here
 * against the guard, rather than via an invented endpoint.
 */
describe('RolesGuard', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  function contextWith(options: {
    isPublic?: boolean;
    roles?: UserRole[];
    user?: AuthenticatedUser;
  }): ExecutionContext {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === IS_PUBLIC_KEY) return options.isPublic;
      if (key === ROLES_KEY) return options.roles;
      return undefined;
    });

    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user: options.user }),
      }),
    } as unknown as ExecutionContext;
  }

  const customer: AuthenticatedUser = { id: 'u1', role: 'CUSTOMER', isGuest: false, jti: 'j1' };
  const admin: AuthenticatedUser = { id: 'u2', role: 'ADMIN', isGuest: false, jti: 'j2' };

  it('allows any authenticated principal when no @Roles() metadata is present', () => {
    expect(guard.canActivate(contextWith({ user: customer }))).toBe(true);
    expect(guard.canActivate(contextWith({ user: admin }))).toBe(true);
  });

  it('always allows @Public() routes regardless of role metadata', () => {
    expect(guard.canActivate(contextWith({ isPublic: true, roles: ['ADMIN'] }))).toBe(true);
  });

  it('allows a CUSTOMER through a route restricted to CUSTOMER', () => {
    expect(guard.canActivate(contextWith({ roles: ['CUSTOMER'], user: customer }))).toBe(true);
  });

  it('allows an ADMIN through a route restricted to ADMIN', () => {
    expect(guard.canActivate(contextWith({ roles: ['ADMIN'], user: admin }))).toBe(true);
  });

  it('rejects a CUSTOMER from an ADMIN-only route with ForbiddenException', () => {
    expect(() => guard.canActivate(contextWith({ roles: ['ADMIN'], user: customer }))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects an ADMIN from a CUSTOMER-only route', () => {
    expect(() => guard.canActivate(contextWith({ roles: ['CUSTOMER'], user: admin }))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects when there is no authenticated principal at all', () => {
    expect(() => guard.canActivate(contextWith({ roles: ['ADMIN'] }))).toThrow(ForbiddenException);
  });
});
