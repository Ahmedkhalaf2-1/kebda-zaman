import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthController } from './auth.controller';
import { AdminAuthController } from './admin-auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { PasswordService } from './password.service';
import { BruteForceService } from './brute-force.service';
import { GoogleAuthService } from './google-auth.service';

@Module({
  // Imported solely to reuse the already-initialized Firebase Admin app
  // (FIREBASE_ADMIN_APP) for verifying Google ID tokens — no second app.
  imports: [NotificationsModule],
  controllers: [AuthController, AdminAuthController],
  providers: [AuthService, TokenService, PasswordService, BruteForceService, GoogleAuthService],
  // TokenService is additionally exported so DriversModule can revoke a
  // driver's refresh-token sessions immediately on deactivation (same
  // mechanism logout-all already uses), not just rely on the next refresh
  // attempt being rejected.
  exports: [PasswordService, TokenService],
})
export class AuthModule {}
