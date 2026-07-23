import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { toUserResponse, UserResponseDto } from '../../common/mappers/user-response.mapper';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getById(id: string): Promise<UserResponseDto> {
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!user) {
      throw new NotFoundException({ message: 'User not found', code: 'USER_NOT_FOUND' });
    }
    return toUserResponse(user);
  }

  async updateProfile(id: string, dto: UpdateProfileDto): Promise<UserResponseDto> {
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        fullName: dto.name,
        phone: dto.phone,
        avatarUrl: dto.avatarUrl,
        locale: dto.locale,
      },
    });
    return toUserResponse(user);
  }
}
