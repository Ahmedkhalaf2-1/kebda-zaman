import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface RequestMeta {
  userAgent?: string;
  ip?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Issues/rotates/revokes tokens (plan §5.2):
 *  - Access token: short-lived JWT, claims {sub, role, isGuest, jti}.
 *  - Refresh token: opaque random string; only its SHA-256 hash is persisted.
 *  - Rotation: every refresh issues a new token in the same `familyId` lineage
 *    and revokes the old one. Presenting an already-revoked/replaced token is
 *    treated as reuse and revokes the entire family (forces re-login).
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Issues a fresh access+refresh pair, starting a new refresh-token family. */
  async issueTokenPair(
    user: Pick<User, 'id' | 'role' | 'isGuest'>,
    meta: RequestMeta,
  ): Promise<TokenPair> {
    const accessToken = await this.signAccessToken(user);
    const refreshToken = await this.createRefreshToken(user.id, randomUUID(), meta);
    return { accessToken, refreshToken };
  }

  private async signAccessToken(user: Pick<User, 'id' | 'role' | 'isGuest'>): Promise<string> {
    const payload = { sub: user.id, role: user.role, isGuest: user.isGuest, jti: randomUUID() };
    return this.jwtService.signAsync(payload, {
      secret: this.config.get<string>('jwt.accessSecret'),
      expiresIn: this.config.get<string>('jwt.accessTtl') as JwtSignOptions['expiresIn'],
    });
  }

  private async createRefreshToken(
    userId: string,
    familyId: string,
    meta: RequestMeta,
  ): Promise<string> {
    const raw = randomBytes(48).toString('base64url');
    const tokenHash = sha256(raw);
    const refreshTtlDays = this.config.get<number>('jwt.refreshTtlDays') ?? 30;
    const expiresAt = new Date(Date.now() + refreshTtlDays * 24 * 60 * 60 * 1000);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        familyId,
        expiresAt,
        userAgent: meta.userAgent,
        ip: meta.ip,
      },
    });

    return raw;
  }

  /**
   * Validates and rotates a presented refresh token. Throws 401 on an
   * unknown, expired, or reused token (reuse revokes the whole family).
   */
  async rotateRefreshToken(rawToken: string, meta: RequestMeta): Promise<TokenPair> {
    const tokenHash = sha256(rawToken);
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!existing) {
      throw new UnauthorizedException({
        message: 'Invalid refresh token',
        code: 'INVALID_REFRESH_TOKEN',
      });
    }

    if (existing.revokedAt) {
      // A revoked/already-rotated token was presented again: reuse detected.
      // Revoke every token in the lineage to force re-authentication.
      await this.prisma.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException({
        message: 'Refresh token reuse detected; all sessions in this lineage were revoked',
        code: 'REFRESH_TOKEN_REUSED',
      });
    }

    if (existing.expiresAt < new Date()) {
      await this.prisma.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException({
        message: 'Refresh token expired',
        code: 'REFRESH_TOKEN_EXPIRED',
      });
    }

    const user = await this.prisma.user.findUnique({ where: { id: existing.userId } });
    if (!user || user.deletedAt) {
      throw new UnauthorizedException({
        message: 'Invalid refresh token',
        code: 'INVALID_REFRESH_TOKEN',
      });
    }

    const newRawToken = await this.createRefreshToken(existing.userId, existing.familyId, meta);
    const newHash = sha256(newRawToken);
    const newRow = await this.prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: newHash },
    });

    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedByTokenId: newRow.id },
    });

    const accessToken = await this.signAccessToken(user);
    return { accessToken, refreshToken: newRawToken };
  }

  /** Revokes a single session (logout). Silently no-ops if not found/not owned/already revoked. */
  async revokeOne(userId: string, rawToken: string): Promise<void> {
    const tokenHash = sha256(rawToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revokes every active session for a user (logout-all). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
