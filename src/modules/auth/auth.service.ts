import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { toUserResponse, UserResponseDto } from '../../common/mappers/user-response.mapper';
import { PasswordService } from './password.service';
import { TokenService, RequestMeta } from './token.service';
import { BruteForceService } from './brute-force.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GuestDto } from './dto/guest.dto';

export interface AuthResult {
  user: UserResponseDto;
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly bruteForce: BruteForceService,
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
  ): Promise<{ accessToken: string; refreshToken: string }> {
    return this.tokenService.rotateRefreshToken(rawRefreshToken, meta);
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
