import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MenuItemResponseDto,
  PUBLIC_MENU_ITEM_INCLUDE,
  toMenuItemResponse,
} from '../../common/mappers/menu-item-response.mapper';

/** Plan §2.20/§4.8: favorite menu items, duplicate-prevented by the unique (userId, menuItemId) index. */
@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<MenuItemResponseDto[]> {
    const favorites = await this.prisma.favorite.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { menuItem: { include: PUBLIC_MENU_ITEM_INCLUDE } },
    });
    return favorites.map((favorite) => toMenuItemResponse(favorite.menuItem));
  }

  /** Returns the full updated list per plan §4.8's `MenuItem[]` response contract. */
  async add(userId: string, menuItemId: string): Promise<MenuItemResponseDto[]> {
    const menuItem = await this.prisma.menuItem.findFirst({
      where: { id: menuItemId, deletedAt: null },
    });
    if (!menuItem) {
      throw new NotFoundException({ message: 'Menu item not found', code: 'MENU_ITEM_NOT_FOUND' });
    }
    const existing = await this.prisma.favorite.findUnique({
      where: { userId_menuItemId: { userId, menuItemId } },
    });
    if (existing) {
      throw new ConflictException({
        message: 'This item is already a favorite',
        code: 'FAVORITE_ALREADY_EXISTS',
      });
    }
    await this.prisma.favorite.create({ data: { userId, menuItemId } });
    return this.list(userId);
  }

  async remove(userId: string, menuItemId: string): Promise<void> {
    const existing = await this.prisma.favorite.findUnique({
      where: { userId_menuItemId: { userId, menuItemId } },
    });
    if (!existing) {
      throw new NotFoundException({ message: 'Favorite not found', code: 'FAVORITE_NOT_FOUND' });
    }
    await this.prisma.favorite.delete({ where: { id: existing.id } });
  }
}
