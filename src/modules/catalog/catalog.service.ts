import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CategoryResponseDto,
  toCategoryResponse,
} from '../../common/mappers/category-response.mapper';
import {
  MenuItemResponseDto,
  toMenuItemResponse,
} from '../../common/mappers/menu-item-response.mapper';
import { ListMenuItemsDto } from './dto/list-menu-items.dto';
import { SearchMenuDto } from './dto/search-menu.dto';

const FEATURED_LIMIT = 10;

/** Only active variants / available addons are exposed to the public catalog. */
const menuItemInclude = {
  variants: {
    where: { isActive: true },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
  },
  addonGroups: {
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    include: {
      addons: {
        where: { isAvailable: true },
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      },
    },
  },
} satisfies Prisma.MenuItemInclude;

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listCategories(): Promise<CategoryResponseDto[]> {
    const categories = await this.prisma.category.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return categories.map(toCategoryResponse);
  }

  async getCategory(id: string): Promise<CategoryResponseDto> {
    const category = await this.prisma.category.findFirst({ where: { id, deletedAt: null } });
    if (!category) {
      throw new NotFoundException({ message: 'Category not found', code: 'CATEGORY_NOT_FOUND' });
    }
    return toCategoryResponse(category);
  }

  async listMenuItems(query: ListMenuItemsDto): Promise<MenuItemResponseDto[]> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const items = await this.prisma.menuItem.findMany({
      where: {
        deletedAt: null,
        isAvailable: true,
        category: { isActive: true, deletedAt: null },
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      },
      include: menuItemInclude,
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    });
    return items.map(toMenuItemResponse);
  }

  async getMenuItem(id: string): Promise<MenuItemResponseDto> {
    const item = await this.prisma.menuItem.findFirst({
      where: { id, deletedAt: null },
      include: menuItemInclude,
    });
    if (!item) {
      throw new NotFoundException({ message: 'Menu item not found', code: 'MENU_ITEM_NOT_FOUND' });
    }
    return toMenuItemResponse(item);
  }

  async search(query: SearchMenuDto): Promise<MenuItemResponseDto[]> {
    const q = query.q.trim();
    if (!q) {
      throw new BadRequestException({
        message: 'Search query must not be empty',
        code: 'SEARCH_QUERY_EMPTY',
      });
    }

    const items = await this.prisma.menuItem.findMany({
      where: {
        deletedAt: null,
        isAvailable: true,
        category: { isActive: true, deletedAt: null },
        OR: [
          { nameAr: { contains: q, mode: 'insensitive' } },
          { nameEn: { contains: q, mode: 'insensitive' } },
        ],
      },
      include: menuItemInclude,
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return items.map(toMenuItemResponse);
  }

  async featured(): Promise<{
    featured: MenuItemResponseDto[];
    categories: CategoryResponseDto[];
  }> {
    const [featuredItems, categories] = await Promise.all([
      this.prisma.menuItem.findMany({
        where: {
          deletedAt: null,
          isAvailable: true,
          isPopular: true,
          category: { isActive: true, deletedAt: null },
        },
        include: menuItemInclude,
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
        take: FEATURED_LIMIT,
      }),
      this.listCategories(),
    ]);
    return { featured: featuredItems.map(toMenuItemResponse), categories };
  }
}
