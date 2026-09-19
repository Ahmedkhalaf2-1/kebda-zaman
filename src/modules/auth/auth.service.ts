import { randomBytes, createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus, Prisma, User, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { toUserResponse, UserResponseDto } from '../../common/mappers/user-response.mapper';
import { PasswordService } from './password.service';
import { TokenService, RequestMeta } from './token.service';
import { BruteForceService } from './brute-force.service';
import { PasswordResetThrottleService } from './password-reset-throttle.service';
import { GoogleAuthService, VerifiedFirebaseIdentity } from './google-auth.service';
import { EmailService } from '../email/email.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GuestDto } from './dto/guest.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { AppleAuthDto } from './dto/apple-auth.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

export interface AuthResult {
  user: UserResponseDto;
  accessToken: string;
  refreshToken: string;
}

/**
 * Terminal order statuses — the only ones that never block account deletion.
 * Mirrors OrdersService's transition maps (orders.service.ts): DELIVERED and
 * PICKED_UP are the two success completions (one per delivery method) and
 * CANCELLED is the terminal non-completion; all three have no outgoing
 * transitions. Every other status (PENDING, CONFIRMED, PREPARING,
 * OUT_FOR_DELIVERY, READY_FOR_PICKUP) is still "in flight" and blocks deletion.
 */
const ORDER_TERMINAL_STATUSES: OrderStatus[] = ['DELIVERED', 'PICKED_UP', 'CANCELLED'];

/**
 * Replaces a DELIVERY order's address snapshot on account deletion. Only
 * `deliveryAddressJson` (a plain Json column — no migration needed) holds
 * personal delivery data on a retained historical order; every other
 * identifying field lives on User, which is anonymized separately.
 */
const REDACTED_DELIVERY_ADDRESS: Prisma.InputJsonValue = {
  redacted: true,
  title: null,
  street: null,
  building: null,
  floor: null,
  apartment: null,
  city: null,
  latitude: null,
  longitude: null,
};

/** Fixed, not env-configurable — the requirement is exactly 15 minutes. */
const PASSWORD_RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Same response for an existing, nonexistent, inactive (deletedAt set), and
 * federated-only (no local passwordHash) account — the whole point is that
 * none of those cases are distinguishable from the outside. Deliberately
 * doesn't claim the email was actually sent (it may not have been, e.g. no
 * account matched, or the provider failed) — only that IF an account is
 * eligible, a link has been dispatched.
 */
const FORGOT_PASSWORD_GENERIC_MESSAGE =
  'If an account exists for this email, a password reset link has been sent.';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly bruteForce: BruteForceService,
    private readonly passwordResetThrottle: PasswordResetThrottleService,
    private readonly googleAuthService: GoogleAuthService,
    private readonly emailService: EmailService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto, meta: RequestMeta): Promise<AuthResult> {
    const existing = await this.prisma.user.findFirst({
      where: { email: dto.email, deletedAt: null },
    });
    if (existing) {
      throw new ConflictException({
        message: 'An account with this email already exists',
        code: 'EMAIL_ALREADY_EXISTS',
      });
    }

    const passwordHash = await this.passwordService.hash(dto.password);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        fullName: dto.name,
        phone: dto.phone,
        role: UserRole.CUSTOMER,
        isGuest: false,
      },
    });

    const tokens = await this.tokenService.issueTokenPair(user, meta);
    return { user: toUserResponse(user), ...tokens };
  }

  async login(dto: LoginDto, meta: RequestMeta): Promise<AuthResult> {
    return this.authenticate(dto, meta, { requireAdmin: false });
  }

  async adminLogin(dto: LoginDto, meta: RequestMeta): Promise<AuthResult> {
    return this.authenticate(dto, meta, { requireAdmin: true });
  }

  /**
   * Google Sign-In via a Firebase ID token (plan: reuse the existing session
   * system — same AuthResult shape as normal login, same JWT access/refresh
   * tokens). Identity comes exclusively from the verified token; nothing in
   * the request body is trusted.
   */
  async googleLogin(dto: GoogleAuthDto, meta: RequestMeta): Promise<AuthResult> {
    const identity = await this.googleAuthService.verify(dto.firebaseIdToken);
    const user = await this.resolveFederatedUser(identity);
    const tokens = await this.tokenService.issueTokenPair(user, meta);
    return { user: toUserResponse(user), ...tokens };
  }

  async appleLogin(dto: AppleAuthDto, meta: RequestMeta): Promise<AuthResult> {
    const identity = await this.googleAuthService.verifyApple(dto.firebaseIdToken);
    const user = await this.resolveFederatedUser(identity);
    const tokens = await this.tokenService.issueTokenPair(user, meta);
    return { user: toUserResponse(user), ...tokens };
  }

  /**
   * Resolution order (plan): existing firebaseUid -> existing verified email
   * (link, preserving passwordHash/name/photo) -> create a new CUSTOMER.
   * Deleted accounts are invisible here, exactly like normal login/register —
   * this schema has no separate suspended/disabled flag, only `deletedAt`.
   */
  private async resolveFederatedUser(identity: VerifiedFirebaseIdentity): Promise<User> {
    const byUid = await this.prisma.user.findFirst({
      where: { firebaseUid: identity.uid, deletedAt: null },
    });
    if (byUid) {
      return byUid;
    }

    const byEmail = await this.prisma.user.findFirst({
      where: { email: { equals: identity.email, mode: 'insensitive' }, deletedAt: null },
    });
    if (byEmail) {
      if (byEmail.firebaseUid) {
        return byEmail;
      }
      // Link the Google identity to the existing email/password account —
      // passwordHash, fullName and avatarUrl are left untouched.
      return this.prisma.user.update({
        where: { id: byEmail.id },
        data: { firebaseUid: identity.uid },
      });
    }

    try {
      return await this.prisma.user.create({
        data: {
          email: identity.email,
          fullName: identity.name?.trim() || identity.email,
          avatarUrl: identity.picture ?? null,
          firebaseUid: identity.uid,
          role: UserRole.CUSTOMER,
          isGuest: false,
        },
      });
    } catch (error) {
      if (this.isUniqueConstraintViolation(error)) {
        // Lost a create race to a concurrent request for the same identity —
        // re-resolve deterministically instead of erroring or duplicating.
        const raced =
          (await this.prisma.user.findFirst({
            where: { firebaseUid: identity.uid, deletedAt: null },
          })) ??
          (await this.prisma.user.findFirst({
            where: { email: { equals: identity.email, mode: 'insensitive' }, deletedAt: null },
          }));
        if (raced) {
          return raced;
        }
      }
      throw error;
    }
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private async authenticate(
    dto: LoginDto,
    meta: RequestMeta,
    options: { requireAdmin: boolean },
  ): Promise<AuthResult> {
    const scope = options.requireAdmin ? 'admin-login' : 'login';
    const key = BruteForceService.key(scope, meta.ip ?? 'unknown', dto.email);
    this.bruteForce.assertNotLocked(key);

    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, deletedAt: null },
    });

    const passwordOk = await this.passwordService.verify(user?.passwordHash ?? null, dto.password);
    if (!user || !passwordOk) {
      this.bruteForce.recordFailure(key);
      throw new UnauthorizedException({
        message: 'Invalid email or password',
        code: 'INVALID_CREDENTIALS',
      });
    }

    if (options.requireAdmin && user.role !== UserRole.ADMIN) {
      this.bruteForce.recordFailure(key);
      throw new ForbiddenException({
        message: 'This account does not have admin access',
        code: 'NOT_ADMIN',
      });
    }

    this.bruteForce.recordSuccess(key);
    const tokens = await this.tokenService.issueTokenPair(user, meta);
    return { user: toUserResponse(user), ...tokens };
  }

  async guest(_dto: GuestDto, meta: RequestMeta): Promise<AuthResult> {
    const user = await this.prisma.user.create({
      data: {
        fullName: 'Guest',
        role: UserRole.CUSTOMER,
        isGuest: true,
      },
    });
    const tokens = await this.tokenService.issueTokenPair(user, meta);
    return { user: toUserResponse(user), ...tokens };
  }

  async refresh(
    rawRefreshToken: string,
    meta: RequestMeta,
    deviceToken?: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    try {
      return await this.tokenService.rotateRefreshToken(rawRefreshToken, meta);
    } catch (error) {
      if (error instanceof UnauthorizedException && deviceToken) {
        try {
          await this.prisma.deviceToken.updateMany({
            where: { token: deviceToken, isActive: true },
            data: { isActive: false },
          });
        } catch {
          this.logger.warn('Failed to deactivate device token after rejected refresh');
        }
      }
      throw error;
    }
  }

  async logout(userId: string, rawRefreshToken?: string): Promise<void> {
    if (rawRefreshToken) {
      await this.tokenService.revokeOne(userId, rawRefreshToken);
    }
  }

  async logoutAll(userId: string): Promise<void> {
    await this.tokenService.revokeAllForUser(userId);
  }

  /**
   * Self-service account deletion. Blocks on any in-flight order, then
   * deletes the Firebase identity (if any) BEFORE touching local data —
   * the safe order: Firebase deletion is idempotent (a retry after a local
   * failure just re-deletes-or-no-ops there), so retrying always converges.
   * The reverse order risks the opposite outcome: local data gone but a
   * live Firebase identity stranded with no local record left to retry
   * against.
   *
   * The User row itself is never hard-deleted — Order.userId is an
   * onDelete: Restrict FK, so a customer with any order history (the common
   * case) can never be hard-deleted without breaking that history. Instead
   * the row is anonymized in place (PII columns cleared, deletedAt set),
   * which already makes every login path reject it (register/login/refresh
   * all filter `deletedAt: null`) — this is the same convention
   * CustomersService.updateStatus uses to deactivate an account.
   */
  async deleteAccount(userId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) {
      // Already deleted (or a repeated request racing the first one) —
      // idempotent success, no signal given back about which case it was.
      return;
    }

    const activeOrder = await this.prisma.order.findFirst({
      where: { userId, status: { notIn: ORDER_TERMINAL_STATUSES } },
      select: { id: true },
    });
    if (activeOrder) {
      throw new ConflictException({
        message: 'Your account cannot be deleted while you have an active order.',
        code: 'ACTIVE_ORDER_EXISTS',
      });
    }

    if (user.firebaseUid) {
      await this.googleAuthService.deleteUser(user.firebaseUid);
    }

    await this.prisma.$transaction(async (tx) => {
      // Personal records with no retention requirement — deleted outright.
      // LoyaltyAccount cascades to LoyaltyTransaction (points aren't
      // financial/accounting history the way Order/Payment are).
      await tx.address.deleteMany({ where: { userId } });
      await tx.favorite.deleteMany({ where: { userId } });
      await tx.loyaltyAccount.deleteMany({ where: { userId } });
      await tx.deviceToken.deleteMany({ where: { userId } });
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.cart.deleteMany({ where: { userId } });

      // Historical orders (and their Payments) are retained for business/
      // accounting history — never deleted — but the one piece of personal
      // delivery data they carry is scrubbed in place.
      await tx.order.updateMany({
        where: { userId, deliveryMethod: 'DELIVERY' },
        data: { deliveryAddressJson: REDACTED_DELIVERY_ADDRESS },
      });

      await tx.user.update({
        where: { id: userId },
        data: {
          email: null,
          passwordHash: null,
          firebaseUid: null,
          fullName: 'Deleted User',
          phone: null,
          avatarUrl: null,
          deletedAt: new Date(),
        },
      });
    });
  }

  /**
   * Self-service "forgot password". The credential authority here is this
   * backend's own `User.passwordHash` — Google/Apple sign-in never touches
   * it (see resolveFederatedUser). Deliberately returns the exact same
   * response regardless of whether the email matches an account, that
   * account is deleted, or that account has no local password at all (a
   * federated-only sign-in) — this never creates a local password for such
   * an account, it just silently does nothing for it, same generic response.
   *
   * `passwordResetThrottle.assertAllowedAndRecord` is synchronous and runs
   * BEFORE any `await`, closing the "concurrent requests for the same
   * email" race named in the requirements — see its own doc comment.
   */
  async forgotPassword(dto: ForgotPasswordDto, meta: RequestMeta): Promise<{ message: string }> {
    this.passwordResetThrottle.assertAllowedAndRecord(dto.email);

    // Exact-match, same as `authenticate()` — this codebase's login is
    // case-sensitive on email today (no `mode: 'insensitive'`), so this
    // stays consistent with it rather than "fixing" that separately.
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, deletedAt: null },
    });

    if (user && user.passwordHash && user.email) {
      await this.issuePasswordResetToken(user as User & { email: string }, meta);
    }

    return { message: FORGOT_PASSWORD_GENERIC_MESSAGE };
  }

  private async issuePasswordResetToken(
    user: User & { email: string },
    meta: RequestMeta,
  ): Promise<void> {
    const rawToken = randomBytes(32).toString('base64url'); // 256 bits of entropy
    const tokenHash = sha256(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS);

    await this.prisma.$transaction([
      // Only one LIVE token per user at a time — an earlier still-valid
      // link (from a previous forgot-password call) stops working once a
      // newer one is issued.
      this.prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
      this.prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash, expiresAt, requestIp: meta.ip },
      }),
    ]);

    const resetUrl = this.config.get<string>('passwordReset.url');
    if (!resetUrl) {
      this.logger.warn(
        'PASSWORD_RESET_URL is not configured — password reset token created but no email can be sent',
      );
      return;
    }
    const resetLink = `${resetUrl}?token=${rawToken}`;

    try {
      await this.emailService.sendPasswordResetEmail({
        to: user.email,
        name: user.fullName,
        locale: user.locale,
        resetLink,
      });
    } catch (error) {
      // Never surfaced to the caller — forgotPassword's response stays
      // generic regardless of provider outcome (task requirement: never
      // claim delivery succeeded, never expose account existence via a
      // provider failure). Logged for operator visibility only; never logs
      // the token, the link, or the recipient — see EmailService's own rule.
      this.logger.warn(
        `Password reset email failed to send: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  /**
   * Consumes a password-reset token. Everything below runs in ONE
   * transaction: the atomic `updateMany` claim (`usedAt: null` in the WHERE
   * clause) is what actually guarantees "concurrent submissions with the
   * same token permit only one success" — two racing transactions can't both
   * match that row; Postgres serializes the conflicting UPDATEs and the
   * loser's `updateMany` matches zero rows. The `deletedAt`/`passwordHash`
   * re-check below the claim guards the rare case where the account stopped
   * being eligible between the forgot-password call and this one; the token
   * is still burned either way (still single-use), it just doesn't change
   * the password.
   *
   * Deliberately does NOT re-null `deletedAt` (never reactivates a disabled
   * account), never touches `role`, and never issues tokens/logs the user in
   * — the response carries no session, matching every other requirement here.
   */
  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const tokenHash = sha256(dto.token);
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.passwordResetToken.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });

      if (claim.count !== 1) {
        const existing = await tx.passwordResetToken.findUnique({ where: { tokenHash } });
        if (!existing) {
          throw new UnauthorizedException({
            message: 'Invalid reset token',
            code: 'INVALID_RESET_TOKEN',
          });
        }
        if (existing.usedAt) {
          throw new UnauthorizedException({
            message: 'This reset link has already been used',
            code: 'RESET_TOKEN_ALREADY_USED',
          });
        }
        throw new UnauthorizedException({
          message: 'This reset link has expired',
          code: 'RESET_TOKEN_EXPIRED',
        });
      }

      const claimed = await tx.passwordResetToken.findUniqueOrThrow({ where: { tokenHash } });
      const user = await tx.user.findUnique({ where: { id: claimed.userId } });
      if (!user || user.deletedAt || !user.passwordHash) {
        // Same generic code as an unknown token — the token is already
        // burned above either way, and this never reveals *why* it failed.
        throw new UnauthorizedException({
          message: 'Invalid reset token',
          code: 'INVALID_RESET_TOKEN',
        });
      }

      const passwordHash = await this.passwordService.hash(dto.password);

      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });

      // Single-use extends to "every other live token for this user", not
      // just the one just consumed (e.g. from an earlier forgot-password
      // call that's still within its 15-minute window).
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      });

      // Revoke every refresh-token session immediately — inlines the same
      // update TokenService.revokeAllForUser does, against `tx` (not
      // `this.prisma`) so it commits atomically with the password change,
      // per the task's "atomically ... revoke refresh sessions" requirement.
      // Outstanding ACCESS tokens are not force-revoked: this codebase
      // deliberately keeps JwtAccessGuard stateless/DB-free on every request
      // (see ActiveDriverGuard's doc comment — the same tradeoff was already
      // made once, for account deactivation, and rejected for cost reasons).
      // A stolen access token therefore keeps working for up to its
      // remaining TTL (JWT_ACCESS_TTL, 15 minutes by default) after a reset,
      // but can never be refreshed again — see PASSWORD_RESET_API_CONTRACT.md.
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });

      return {
        message: 'Your password has been reset. Please log in again with your new password.',
      };
    });
  }
}
