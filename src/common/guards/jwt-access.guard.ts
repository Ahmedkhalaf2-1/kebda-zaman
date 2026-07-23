import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { UserRole } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  isGuest: boolean;
  jti: string;
}

/**
 * Global guard: verifies the `Authorization: Bearer <token>` access JWT and
 * attaches the decoded principal to `request.user`. Routes marked `@Public()`
 * bypass this check entirely.
 */
@Injectable()
export class JwtAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException({
        message: 'Missing access token',
        code: 'UNAUTHORIZED',
      });
    }

    try {
      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.get<string>('jwt.accessSecret'),
      });
      request.user = {
        id: payload.sub,
        role: payload.role,
        isGuest: payload.isGuest,
        jti: payload.jti,
      };
      return true;
    } catch {
      throw new UnauthorizedException({
        message: 'Invalid or expired access token',
        code: 'INVALID_TOKEN',
      });
    }
  }

  private extractToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) {
      return undefined;
    }
    const [scheme, token] = header.split(' ');
    return scheme === 'Bearer' && token ? token : undefined;
  }
}
