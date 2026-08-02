import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminCategoryResponseDto,
  CategoryResponseDto,
  toAdminCategoryResponse,
  toCategoryResponse,
} from '../../common/mappers/category-response.mapper';
import {
  ADMIN_MENU_ITEM_INCLUDE,
  AdminMenuItemResponseDto,
  MenuItemResponseDto,
  PUBLIC_MENU_ITEM_INCLUDE,
  toAdminMenuItemResponse,
  toMenuItemResponse,
} from '../../common/mappers/menu-item-response.mapper';
import { ListMenuItemsDto } from './dto/list-menu-items.dto';
import { SearchMenuDto } from './dto/search-menu.dto';
import { CategoryDto } from './dto/category.dto';
import { AddonDto, AddonGroupDto, MenuItemDto, VariantDto } from './dto/menu-item.dto';
import { AdminListMenuItemsDto } from './dto/admin-list-menu-items.dto';

const FEATURED_LIMIT = 10;
const menuItemInclude = PUBLIC_MENU_ITEM_INCLUDE;

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

  // ===========================================================================
  // Admin — Categories (plan §4.19)
  // ===========================================================================

  async adminListCategories(): Promise<AdminCategoryResponseDto[]> {
    const categories = await this.prisma.category.findMany({
      where: { deletedAt: null },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return categories.map(toAdminCategoryResponse);
  }

  async createCategory(dto: CategoryDto): Promise<AdminCategoryResponseDto> {
    const category = await this.prisma.category.create({
      data: {
        nameAr: dto.nameAr,
        nameEn: dto.nameEn,
        iconUrl: dto.iconUrl,
        displayOrder: dto.displayOrder ?? 0,
      },
    });
    return toAdminCategoryResponse(category);
  }

  async updateCategory(id: string, dto: CategoryDto): Promise<AdminCategoryResponseDto> {
    const existing = await this.prisma.category.findFirst({ where: { id, deletedAt: null } });
    if (!existing) {
      throw new NotFoundException({ message: 'Category not found', code: 'CATEGORY_NOT_FOUND' });
    }
    const updated = await this.prisma.category.update({
      where: { id },
      data: {
        nameAr: dto.nameAr,
        nameEn: dto.nameEn,
        iconUrl: dto.iconUrl,
        displayOrder: dto.displayOrder ?? existing.displayOrder,
      },
    });
    return toAdminCategoryResponse(updated);
  }

  /** Soft delete; blocked while active menu items still reference it (plan §4.19). */
  async deleteCategory(id: string): Promise<void> {
    const existing = await this.prisma.category.findFirst({ where: { id, deletedAt: null } });
    if (!existing) {
      throw new NotFoundException({ message: 'Category not found', code: 'CATEGORY_NOT_FOUND' });
    }
    const itemCount = await this.prisma.menuItem.count({
      where: { categoryId: id, deletedAt: null },
    });
    if (itemCount > 0) {
      throw new ConflictException({
        message: 'Cannot delete a category that still has menu items attached',
        code: 'CATEGORY_HAS_ITEMS',
      });
    }
    await this.prisma.category.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  // ===========================================================================
  // Admin — Menu items (plan §4.18)
  // ===========================================================================

  async adminListMenuItems(query: AdminListMenuItemsDto): Promise<AdminMenuItemResponseDto[]> {
    const items = await this.prisma.menuItem.findMany({
      where: {
        deletedAt: null,
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.q
          ? {
              OR: [
                { nameAr: { contains: query.q, mode: 'insensitive' } },
                { nameEn: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: ADMIN_MENU_ITEM_INCLUDE,
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return items.map(toAdminMenuItemResponse);
  }

  async createMenuItem(dto: MenuItemDto): Promise<AdminMenuItemResponseDto> {
    await this.assertCategoryExists(dto.categoryId);
    this.assertValidCompareAtPrice(dto.basePrice, dto.compareAtPrice ?? null);

    const created = await this.prisma.menuItem.create({
      data: {
        categoryId: dto.categoryId,
        nameAr: dto.nameAr,
        nameEn: dto.nameEn,
        descriptionAr: dto.descriptionAr,
        descriptionEn: dto.descriptionEn,
        basePrice: dto.basePrice,
        calories: dto.calories,
        compareAtPrice: dto.compareAtPrice,
        badge: dto.badge,
        imageUrl: dto.imageUrl,
        isAvailable: dto.isAvailable ?? true,
        isPopular: dto.isPopular ?? false,
        displayOrder: dto.displayOrder,
        variants: dto.variants?.length
          ? {
              create: dto.variants.map((variant) => ({
                nameAr: variant.nameAr,
                nameEn: variant.nameEn,
                priceDelta: variant.priceDelta,
                isDefault: variant.isDefault ?? false,
                isActive: variant.isActive ?? true,
                displayOrder: variant.displayOrder,
              })),
            }
          : undefined,
        addonGroups: dto.addonGroups?.length
          ? {
              create: dto.addonGroups.map((group) => ({
                titleAr: group.titleAr,
                titleEn: group.titleEn,
                isRequired: group.isRequired ?? false,
                minSelect: group.minSelect ?? 0,
                maxSelect: group.maxSelect ?? 1,
                displayOrder: group.displayOrder,
                addons: {
                  create: group.addons.map((addon) => ({
                    nameAr: addon.nameAr,
                    nameEn: addon.nameEn,
                    price: addon.price,
                    isAvailable: addon.isAvailable ?? true,
                    displayOrder: addon.displayOrder,
                  })),
                },
              })),
            }
          : undefined,
      },
      include: ADMIN_MENU_ITEM_INCLUDE,
    });
    return toAdminMenuItemResponse(created);
  }

  /**
   * Full replace (plan §4.18). When `variants`/`addonGroups` are provided,
   * each entry with an existing `id` is updated in place, entries without an
   * `id` are created, and any existing row not present in the submitted set
   * is deleted — inside one transaction (atomic multi-entity write).
   */
  async updateMenuItem(id: string, dto: MenuItemDto): Promise<AdminMenuItemResponseDto> {
    const existing = await this.prisma.menuItem.findFirst({ where: { id, deletedAt: null } });
    if (!existing) {
      throw new NotFoundException({ message: 'Menu item not found', code: 'MENU_ITEM_NOT_FOUND' });
    }
    if (dto.categoryId !== existing.categoryId) {
      await this.assertCategoryExists(dto.categoryId);
    }

    // Tri-state: property omitted -> preserve existing value; property present as
    // `null` -> clear it; property present with a value -> replace it.
    const effectiveCalories = dto.calories !== undefined ? dto.calories : existing.calories;
    const effectiveCompareAtPrice =
      dto.compareAtPrice !== undefined
        ? dto.compareAtPrice
        : (existing.compareAtPrice?.toNumber() ?? null);
    const effectiveBadge = dto.badge !== undefined ? dto.badge : existing.badge;
    this.assertValidCompareAtPrice(dto.basePrice, effectiveCompareAtPrice);

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.menuItem.update({
          where: { id },
          data: {
            categoryId: dto.categoryId,
            nameAr: dto.nameAr,
            nameEn: dto.nameEn,
            descriptionAr: dto.descriptionAr,
            descriptionEn: dto.descriptionEn,
            basePrice: dto.basePrice,
            calories: effectiveCalories,
            compareAtPrice: effectiveCompareAtPrice,
            badge: effectiveBadge,
            imageUrl: dto.imageUrl,
            isAvailable: dto.isAvailable ?? existing.isAvailable,
            isPopular: dto.isPopular ?? existing.isPopular,
            displayOrder: dto.displayOrder ?? existing.displayOrder,
          },
        });

        if (dto.variants) {
          await this.syncVariants(tx, id, dto.variants);
        }
        if (dto.addonGroups) {
          await this.syncAddonGroups(tx, id, dto.addonGroups);
        }

        return tx.menuItem.findUniqueOrThrow({ where: { id }, include: ADMIN_MENU_ITEM_INCLUDE });
      });
      return toAdminMenuItemResponse(updated);
    } catch (error) {
      if (this.isForeignKeyViolation(error)) {
        throw new ConflictException({
          message:
            'Cannot remove a variant or add-on that is currently referenced by an active cart',
          code: 'MENU_ENTITY_IN_USE',
        });
      }
      throw error;
    }
  }

  async setMenuItemAvailability(
    id: string,
    isAvailable: boolean,
  ): Promise<AdminMenuItemResponseDto> {
    const existing = await this.prisma.menuItem.findFirst({ where: { id, deletedAt: null } });
    if (!existing) {
      throw new NotFoundException({ message: 'Menu item not found', code: 'MENU_ITEM_NOT_FOUND' });
    }
    const updated = await this.prisma.menuItem.update({
      where: { id },
      data: { isAvailable },
      include: ADMIN_MENU_ITEM_INCLUDE,
    });
    return toAdminMenuItemResponse(updated);
  }

  /** Soft delete — order history never live-references a MenuItem (snapshots only), so this is safe. */
  async deleteMenuItem(id: string): Promise<void> {
    const existing = await this.prisma.menuItem.findFirst({ where: { id, deletedAt: null } });
    if (!existing) {
      throw new NotFoundException({ message: 'Menu item not found', code: 'MENU_ITEM_NOT_FOUND' });
    }
    await this.prisma.menuItem.update({
      where: { id },
      data: { deletedAt: new Date(), isAvailable: false },
    });
  }

  /** compareAtPrice is a display-only "previous price" — never swapped, cleared, or recalculated here. */
  private assertValidCompareAtPrice(basePrice: number, compareAtPrice: number | null): void {
    if (compareAtPrice !== null && compareAtPrice <= basePrice) {
      throw new UnprocessableEntityException({
        message: 'Compare-at price must be greater than base price',
        code: 'INVALID_COMPARE_AT_PRICE',
      });
    }
  }

  private async assertCategoryExists(categoryId: string): Promise<void> {
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, deletedAt: null },
    });
    if (!category) {
      throw new UnprocessableEntityException({
        message: 'Category does not exist',
        code: 'INVALID_CATEGORY',
      });
    }
  }

  /** Prevents cross-item variant association: an id must belong to this item's own variants. */
  private async syncVariants(
    tx: Prisma.TransactionClient,
    menuItemId: string,
    variantDtos: VariantDto[],
  ): Promise<void> {
    const existing = await tx.itemVariant.findMany({ where: { menuItemId }, select: { id: true } });
    const existingIds = new Set(existing.map((variant) => variant.id));

    for (const variant of variantDtos) {
      if (variant.id && !existingIds.has(variant.id)) {
        throw new UnprocessableEntityException({
          message: 'Variant does not belong to this menu item',
          code: 'INVALID_VARIANT_ASSOCIATION',
        });
      }
    }

    const submittedIds = new Set(variantDtos.filter((v) => v.id).map((v) => v.id as string));
    const idsToDelete = [...existingIds].filter((existingId) => !submittedIds.has(existingId));
    if (idsToDelete.length > 0) {
      await tx.itemVariant.deleteMany({ where: { id: { in: idsToDelete } } });
    }

    for (const variant of variantDtos) {
      const data = {
        nameAr: variant.nameAr,
        nameEn: variant.nameEn,
        priceDelta: variant.priceDelta,
        isDefault: variant.isDefault ?? false,
        isActive: variant.isActive ?? true,
        displayOrder: variant.displayOrder,
      };
      if (variant.id) {
        await tx.itemVariant.update({ where: { id: variant.id }, data });
      } else {
        await tx.itemVariant.create({ data: { ...data, menuItemId } });
      }
    }
  }

  /** Prevents cross-item/cross-group association: group ids scoped to this item, addon ids to their group. */
  private async syncAddonGroups(
    tx: Prisma.TransactionClient,
    menuItemId: string,
    groupDtos: AddonGroupDto[],
  ): Promise<void> {
    const existingGroups = await tx.addonGroup.findMany({
      where: { menuItemId },
      select: { id: true },
    });
    const existingGroupIds = new Set(existingGroups.map((group) => group.id));

    for (const group of groupDtos) {
      if (group.id && !existingGroupIds.has(group.id)) {
        throw new UnprocessableEntityException({
          message: 'Addon group does not belong to this menu item',
          code: 'INVALID_ADDON_GROUP_ASSOCIATION',
        });
      }
    }

    const submittedGroupIds = new Set(groupDtos.filter((g) => g.id).map((g) => g.id as string));
    const groupIdsToDelete = [...existingGroupIds].filter((id) => !submittedGroupIds.has(id));
    if (groupIdsToDelete.length > 0) {
      // Cascades to that group's Addon rows (schema onDelete: Cascade).
      await tx.addonGroup.deleteMany({ where: { id: { in: groupIdsToDelete } } });
    }

    for (const group of groupDtos) {
      const groupData = {
        titleAr: group.titleAr,
        titleEn: group.titleEn,
        isRequired: group.isRequired ?? false,
        minSelect: group.minSelect ?? 0,
        maxSelect: group.maxSelect ?? 1,
        displayOrder: group.displayOrder,
      };

      const groupId = group.id
        ? (await tx.addonGroup.update({ where: { id: group.id }, data: groupData })).id
        : (await tx.addonGroup.create({ data: { ...groupData, menuItemId } })).id;

      await this.syncAddons(tx, groupId, group.addons);
    }
  }

  private async syncAddons(
    tx: Prisma.TransactionClient,
    addonGroupId: string,
    addonDtos: AddonDto[],
  ): Promise<void> {
    const existingAddons = await tx.addon.findMany({
      where: { addonGroupId },
      select: { id: true },
    });
    const existingAddonIds = new Set(existingAddons.map((addon) => addon.id));

    for (const addon of addonDtos) {
      if (addon.id && !existingAddonIds.has(addon.id)) {
        throw new UnprocessableEntityException({
          message: 'Addon does not belong to this addon group',
          code: 'INVALID_ADDON_ASSOCIATION',
        });
      }
    }

    const submittedAddonIds = new Set(addonDtos.filter((a) => a.id).map((a) => a.id as string));
    const addonIdsToDelete = [...existingAddonIds].filter((id) => !submittedAddonIds.has(id));
    if (addonIdsToDelete.length > 0) {
      await tx.addon.deleteMany({ where: { id: { in: addonIdsToDelete } } });
    }

    for (const addon of addonDtos) {
      const data = {
        nameAr: addon.nameAr,
        nameEn: addon.nameEn,
        price: addon.price,
        isAvailable: addon.isAvailable ?? true,
        displayOrder: addon.displayOrder,
      };
      if (addon.id) {
        await tx.addon.update({ where: { id: addon.id }, data });
      } else {
        await tx.addon.create({ data: { ...data, addonGroupId } });
      }
    }
  }

  private isForeignKeyViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
  }
}
