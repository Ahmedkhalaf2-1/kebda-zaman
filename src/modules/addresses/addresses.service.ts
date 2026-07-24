import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Address } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AddressDto } from './dto/address.dto';

export interface AddressResponseDto {
  id: string;
  userId: string;
  title: string;
  street: string;
  building: string;
  floor: string | null;
  apartment: string | null;
  city: string;
  notes: string | null;
  latitude: number | null;
  longitude: number | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

function toAddressResponse(address: Address): AddressResponseDto {
  return {
    id: address.id,
    userId: address.userId,
    title: address.title,
    street: address.street,
    building: address.building,
    floor: address.floor,
    apartment: address.apartment,
    city: address.city,
    notes: address.notes,
    latitude: address.latitude?.toNumber() ?? null,
    longitude: address.longitude?.toNumber() ?? null,
    isDefault: address.isDefault,
    createdAt: address.createdAt.toISOString(),
    updatedAt: address.updatedAt.toISOString(),
  };
}

/** Plan §2.3/§4.4: saved delivery addresses, at most one `isDefault=true` per user. */
@Injectable()
export class AddressesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<AddressResponseDto[]> {
    const addresses = await this.prisma.address.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return addresses.map(toAddressResponse);
  }

  async create(userId: string, dto: AddressDto): Promise<AddressResponseDto> {
    const existingCount = await this.prisma.address.count({ where: { userId } });
    // The very first address is always the default — never leave a user with zero defaults.
    const isDefault = existingCount === 0 ? true : (dto.isDefault ?? false);

    const created = await this.prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.address.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.address.create({
        data: {
          userId,
          title: dto.title,
          street: dto.street,
          building: dto.building,
          floor: dto.floor,
          apartment: dto.apartment,
          city: dto.city,
          notes: dto.notes,
          latitude: dto.latitude,
          longitude: dto.longitude,
          isDefault,
        },
      });
    });
    return toAddressResponse(created);
  }

  async update(userId: string, id: string, dto: AddressDto): Promise<AddressResponseDto> {
    const existing = await this.findOwned(userId, id);
    const isDefault = dto.isDefault ?? existing.isDefault;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (isDefault && !existing.isDefault) {
        await tx.address.updateMany({
          where: { userId, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.address.update({
        where: { id },
        data: {
          title: dto.title,
          street: dto.street,
          building: dto.building,
          floor: dto.floor ?? null,
          apartment: dto.apartment ?? null,
          city: dto.city,
          notes: dto.notes ?? null,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          isDefault,
        },
      });
    });
    return toAddressResponse(updated);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.findOwned(userId, id);
    await this.prisma.address.delete({ where: { id } });
  }

  async setDefault(userId: string, id: string): Promise<AddressResponseDto> {
    await this.findOwned(userId, id);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.address.updateMany({
        where: { userId, isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
      return tx.address.update({ where: { id }, data: { isDefault: true } });
    });
    return toAddressResponse(updated);
  }

  /** 404 for a nonexistent id, 403 for one that belongs to someone else (plan §4.4 error table). */
  private async findOwned(userId: string, id: string): Promise<Address> {
    const address = await this.prisma.address.findUnique({ where: { id } });
    if (!address) {
      throw new NotFoundException({ message: 'Address not found', code: 'ADDRESS_NOT_FOUND' });
    }
    if (address.userId !== userId) {
      throw new ForbiddenException({
        message: 'This address belongs to another user',
        code: 'FORBIDDEN',
      });
    }
    return address;
  }
}
