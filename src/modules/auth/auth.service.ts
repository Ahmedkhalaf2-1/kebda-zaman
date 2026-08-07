import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { OrderStatus, Prisma, User, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { toUserResponse, UserResponseDto } from '../../common/mappers/user-response.mapper';
import { PasswordService } from './password.service';
import { TokenService, RequestMeta } from './token.service';
import { BruteForceService } from './brute-force.service';
import { GoogleAuthService, VerifiedGoogleIdentity } from './google-auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GuestDto } from './dto/guest.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';

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

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly bruteForce: BruteForceService,
    private readonly googleAuthService: GoogleAuthService,
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
    const user = await this.resolveGoogleUser(identity);
    const tokens = await this.tokenService.issueTokenPair(user, meta);
    return { user: toUserResponse(user), ...tokens };
  }

  /**
   * Resolution order (plan): existing firebaseUid -> existing verified email
   * (link, preserving passwordHash/name/photo) -> create a new CUSTOMER.
   * Deleted accounts are invisible here, exactly like normal login/register —
   * this schema has no separate suspended/disabled flag, only `deletedAt`.
   */
  private async resolveGoogleUser(identity: VerifiedGoogleIdentity): Promise<User> {
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
        } catch (cleanupError) {
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
}
