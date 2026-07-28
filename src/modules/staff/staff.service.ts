import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { StaffResponseDto, toStaffResponse } from '../../common/mappers/staff-response.mapper';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
  ) {}

  async list(): Promise<StaffResponseDto[]> {
    const staff = await this.prisma.user.findMany({
      where: { role: UserRole.CASHIER },
      orderBy: { createdAt: 'desc' },
    });
    return staff.map(toStaffResponse);
  }

  async create(dto: CreateStaffDto): Promise<StaffResponseDto> {
    await this.assertEmailAvailable(dto.email);

    const passwordHash = await this.passwordService.hash(dto.password);
    const created = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        fullName: dto.name,
        phone: dto.phone,
        role: UserRole.CASHIER,
        isGuest: false,
      },
    });
    return toStaffResponse(created);
  }

  async update(id: string, dto: UpdateStaffDto): Promise<StaffResponseDto> {
    const staff = await this.findCashierOrThrow(id);

    if (dto.email && dto.email !== staff.email) {
      await this.assertEmailAvailable(dto.email, id);
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        fullName: dto.name,
        email: dto.email,
        phone: dto.phone,
        passwordHash: dto.password ? await this.passwordService.hash(dto.password) : undefined,
        deletedAt: dto.isActive === undefined ? undefined : dto.isActive ? null : new Date(),
      },
    });
    return toStaffResponse(updated);
  }

  private async assertEmailAvailable(email: string, excludeId?: string): Promise<void> {
    const existing = await this.prisma.user.findFirst({
      where: { email, deletedAt: null, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    });
    if (existing) {
      throw new ConflictException({
        message: 'An account with this email already exists',
        code: 'EMAIL_ALREADY_EXISTS',
      });
    }
  }

  private async findCashierOrThrow(id: string) {
    const staff = await this.prisma.user.findFirst({ where: { id, role: UserRole.CASHIER } });
    if (!staff) {
      throw new NotFoundException({ message: 'Staff account not found', code: 'STAFF_NOT_FOUND' });
    }
    return staff;
  }
}
