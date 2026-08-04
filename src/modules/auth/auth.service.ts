import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, User, UserRole } from '@prisma/client';
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
}
