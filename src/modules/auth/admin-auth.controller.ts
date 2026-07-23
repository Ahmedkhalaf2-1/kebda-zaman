import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { AUTH_THROTTLE } from './auth-throttle.const';
import { extractRequestMeta } from './request-meta.util';

/** Primary admin-login path, as explicitly specified for this phase. */
@Controller({ path: 'admin/auth', version: '1' })
export class AdminAuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.adminLogin(dto, extractRequestMeta(req));
  }
}
