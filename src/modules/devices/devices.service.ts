import { Injectable, NotFoundException } from '@nestjs/common';
import { DeviceToken } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { UpdateDeviceTokenDto } from './dto/update-device-token.dto';
import { DeleteDeviceTokenDto } from './dto/delete-device-token.dto';

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert by unique token (plan §9.2). Always re-attaches the calling
   * user — a device token belongs to one physical installation, and a
   * different account logging in on that device should take it over
   * (matches the frontend's `syncTokenWithBackend` -> this endpoint).
   * `userId` is a real guest-or-customer user id here: every caller is
   * authenticated (guest sessions already have a real user row), so the
   * nullable DeviceToken.userId column is exercised only for tokens no
   * caller has claimed yet — see report.
   */
  async register(userId: string, dto: RegisterDeviceDto): Promise<DeviceToken> {
    return this.prisma.deviceToken.upsert({
      where: { token: dto.token },
      update: { userId, platform: dto.platform, isActive: true, lastSeenAt: new Date() },
      create: {
        userId,
        token: dto.token,
        platform: dto.platform,
        lastSeenAt: new Date(),
        isActive: true,
      },
    });
  }

  /** FCM token refresh (plan §9.2/§9.3): moves the record from oldToken to token. */
  async updateToken(userId: string, dto: UpdateDeviceTokenDto): Promise<DeviceToken> {
    if (!dto.oldToken) {
      return this.register(userId, dto);
    }

    const existing = await this.findOwned(userId, dto.oldToken);

    if (dto.oldToken === dto.token) {
      return this.prisma.deviceToken.update({
        where: { token: dto.oldToken },
        data: { userId, platform: dto.platform, isActive: true, lastSeenAt: new Date() },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      // A stale row might already exist at the new token value; clear it
      // first so the rename below never collides with the unique constraint.
      await tx.deviceToken.deleteMany({ where: { token: dto.token, id: { not: existing.id } } });
      return tx.deviceToken.update({
        where: { id: existing.id },
        data: {
          token: dto.token,
          userId,
          platform: dto.platform,
          isActive: true,
          lastSeenAt: new Date(),
        },
      });
    });
  }

  /** Logout (plan §9.3): removes the token for this device only. */
  async deleteToken(userId: string, dto: DeleteDeviceTokenDto): Promise<void> {
    const existing = await this.findOwned(userId, dto.token);
    await this.prisma.deviceToken.delete({ where: { id: existing.id } });
  }

  /**
   * A token with no owner yet (guest device never claimed) is
   * token-scoped: knowing the exact token is itself the authorization
   * (plan §4.15: "Access or token-scoped"). A token owned by a *different*
   * user is never visible to this caller.
   */
  private async findOwned(userId: string, token: string): Promise<DeviceToken> {
    const existing = await this.prisma.deviceToken.findUnique({ where: { token } });
    if (!existing || (existing.userId && existing.userId !== userId)) {
      throw new NotFoundException({
        message: 'Device token not found',
        code: 'DEVICE_TOKEN_NOT_FOUND',
      });
    }
    return existing;
  }
}
