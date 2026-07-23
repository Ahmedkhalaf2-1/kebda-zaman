import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AdminAuthController } from './admin-auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { PasswordService } from './password.service';
import { BruteForceService } from './brute-force.service';

@Module({
  controllers: [AuthController, AdminAuthController],
  providers: [AuthService, TokenService, PasswordService, BruteForceService],
})
export class AuthModule {}
