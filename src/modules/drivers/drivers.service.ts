import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { DriverResponseDto, toDriverResponse } from '../../common/mappers/driver-response.mapper';
import { CreateDriverDto } from './dto/create-driver.dto';
import { UpdateDriverDto } from './dto/update-driver.dto';
import { ListDriversDto } from './dto/list-drivers.dto';

@Injectable()
export class DriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
  ) {}

  async list(query: ListDriversDto): Promise<DriverResponseDto[]> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const drivers = await this.prisma.user.findMany({
      where: {
        role: UserRole.DRIVER,
        ...(query.isActive === undefined
          ? {}
          : query.isActive
            ? { deletedAt: null }
            : { deletedAt: { not: null } }),
        ...(query.q
          ? {
              OR: [
                { fullName: { contains: query.q, mode: 'insensitive' as const } },
                { email: { contains: query.q, mode: 'insensitive' as const } },
                { phone: { contains: query.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return drivers.map(toDriverResponse);
  }

  async getById(id: string): Promise<DriverResponseDto> {
    const driver = await this.findDriverOrThrow(id);
    return toDriverResponse(driver);
  }

  async create(dto: CreateDriverDto): Promise<DriverResponseDto> {
    await this.assertEmailAvailable(dto.email);

    const passwordHash = await this.passwordService.hash(dto.password);
    const created = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        fullName: dto.name,
        phone: dto.phone,
        role: UserRole.DRIVER,
        isGuest: false,
      },
    });
    return toDriverResponse(created);
  }

  async update(id: string, dto: UpdateDriverDto): Promise<DriverResponseDto> {
    const driver = await this.findDriverOrThrow(id);

    if (dto.email && dto.email !== driver.email) {
      await this.assertEmailAvailable(dto.email, id);
    }

    const isDeactivating = dto.isActive === false && driver.deletedAt === null;

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

    if (isDeactivating) {
      // Kills every existing refresh-token session immediately (same
      // mechanism as logout-all) — belt-and-suspenders alongside
      // ActiveDriverGuard, which is what actually blocks a still-valid
      // access token from being used again.
      await this.tokenService.revokeAllForUser(id);
    }

    // Orders already assigned to this driver are deliberately left
    // untouched (driverId is not cleared) — an admin can see the
    // assignment and reassign it; see the Order.driverId schema comment.
    return toDriverResponse(updated);
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

  private async findDriverOrThrow(id: string) {
    const driver = await this.prisma.user.findFirst({
      where: { id, role: UserRole.DRIVER },
    });
    if (!driver) {
      throw new NotFoundException({ message: 'Driver not found', code: 'DRIVER_NOT_FOUND' });
    }
    return driver;
  }
}
