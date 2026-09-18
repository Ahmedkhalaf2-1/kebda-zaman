import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

/**
 * Closes a gap that exists for every other role in this codebase: JwtAccessGuard
 * only verifies the access-token *signature*, never re-reads the user row, so a
 * deactivated account's still-valid (not yet expired) access token keeps working
 * until it naturally expires — deactivation only blocks the next login/refresh
 * (see AuthService.authenticate / TokenService.rotateRefreshToken, both of which
 * filter `deletedAt: null`).
 *
 * Drivers need this closed immediately (an admin deactivating a driver mid-shift
 * must stop them from acting on orders right away), so this guard re-checks the
 * DB on every request — but ONLY for principals whose token claims DRIVER, and
 * only on the driver-facing controllers that apply it. It is deliberately not
 * registered globally: doing so would add a DB round-trip to every request for
 * every role, which is unnecessary for this phase's scope (customers/admin/
 * cashier/kitchen deactivation semantics are unchanged).
 */
@Injectable()
export class ActiveDriverGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;
    // JwtAccessGuard/RolesGuard (global APP_GUARDs, run before this one) already
    // enforce authentication and the DRIVER role for the routes this guard is
    // applied to — this is just defense in depth, never the primary check.
    if (!user || user.role !== 'DRIVER') {
      return true;
    }

    const driver = await this.prisma.user.findFirst({
      where: { id: user.id, role: 'DRIVER', deletedAt: null },
      select: { id: true },
    });
    if (!driver) {
      throw new UnauthorizedException({
        message: 'This driver account has been deactivated',
        code: 'DRIVER_DEACTIVATED',
      });
    }
    return true;
  }
}
