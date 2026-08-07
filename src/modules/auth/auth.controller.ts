import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { LogoutDto } from './dto/logout.dto';
import { GuestDto } from './dto/guest.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { AUTH_THROTTLE } from './auth-throttle.const';
import { extractRequestMeta } from './request-meta.util';

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.CREATED)
  @Post('register')
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.authService.register(dto, extractRequestMeta(req));
  }

  // Alias per plan §4.1/D6 — same handler, kept until the frontend targets one canonical path.
  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.CREATED)
  @Post('signup')
  signup(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.authService.register(dto, extractRequestMeta(req));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, extractRequestMeta(req));
  }

  // Plan-canonical alias for admin login (§5.1); primary path is AdminAuthController.
  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @Post('admin/login')
  adminLoginAlias(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.adminLogin(dto, extractRequestMeta(req));
  }

  // Login endpoint (not authenticated) — same rate-limit class as /login.
  // Identity is derived entirely from the verified Firebase ID token; no
  // client-supplied field can influence the resolved account or its role.
  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @Post('google')
  googleLogin(@Body() dto: GoogleAuthDto, @Req() req: Request) {
    return this.authService.googleLogin(dto, extractRequestMeta(req));
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.authService.refresh(
      dto.refreshToken,
      extractRequestMeta(req),
      dto.deviceToken,
    );
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  async logout(@CurrentUser() user: AuthenticatedUser, @Body() dto: LogoutDto): Promise<void> {
    await this.authService.logout(user.id, dto.refreshToken);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout-all')
  async logoutAll(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.authService.logoutAll(user.id);
  }

  @Public()
  @HttpCode(HttpStatus.CREATED)
  @Post('guest')
  guest(@Body() dto: GuestDto, @Req() req: Request) {
    return this.authService.guest(dto, extractRequestMeta(req));
  }

  // Self-service account deletion. Requires an authenticated, non-guest
  // CUSTOMER — the global JwtAccessGuard already rejects unauthenticated
  // requests, @Roles('CUSTOMER') rejects ADMIN/CASHIER principals, and the
  // isGuest check below rejects guest sessions. The target is always the
  // caller's own id from the verified access token — never a request body
  // or URL param — so this can never delete another account.
  @Roles('CUSTOMER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('account')
  async deleteAccount(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    if (user.isGuest) {
      throw new ForbiddenException({
        message: 'Guest accounts cannot be deleted through this endpoint',
        code: 'GUEST_NOT_ELIGIBLE',
      });
    }
    await this.authService.deleteAccount(user.id);
  }
}
