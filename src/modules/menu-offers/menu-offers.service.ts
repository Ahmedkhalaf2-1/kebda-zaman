import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminMenuOfferResponseDto,
  MenuOfferResponseDto,
  toAdminMenuOfferResponse,
  toMenuOfferResponse,
} from '../../common/mappers/menu-offer-response.mapper';
import { MenuOfferDto } from './dto/menu-offer.dto';

const menuOfferInclude = { menuItem: true } as const;

@Injectable()
export class MenuOffersService {
  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // Customer — visible offers only
  // ===========================================================================

  /**
   * active + (no startAt or already started) + (no endAt or not yet expired) +
   * linked MenuItem not soft-deleted. Deliberately does NOT require
   * menuItem.isAvailable — that flag represents temporary stock-outs (same
   * semantics GET /menu/items/:id already relies on, which stays reachable
   * regardless of isAvailable), so a sold-out item's banner still links
   * through to its detail page rather than disappearing.
   */
  async listVisible(): Promise<MenuOfferResponseDto[]> {
    const now = new Date();
    const offers = await this.prisma.menuOffer.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startAt: null }, { startAt: { lte: now } }] },
          { OR: [{ endAt: null }, { endAt: { gte: now } }] },
        ],
        menuItem: { deletedAt: null },
      },
      include: menuOfferInclude,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return offers.map(toMenuOfferResponse);
  }

  // ===========================================================================
  // Admin CRUD
  // ===========================================================================

  async adminList(): Promise<AdminMenuOfferResponseDto[]> {
    const offers = await this.prisma.menuOffer.findMany({
      include: menuOfferInclude,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return offers.map(toAdminMenuOfferResponse);
  }

  async create(dto: MenuOfferDto): Promise<AdminMenuOfferResponseDto> {
    await this.assertMenuItemExists(dto.menuItemId);
    this.assertValidDateRange(dto.startAt, dto.endAt);

    const created = await this.prisma.menuOffer.create({
      data: {
        menuItemId: dto.menuItemId,
        imageUrl: dto.imageUrl,
        title: dto.title ?? null,
        description: dto.description ?? null,
        isActive: dto.isActive ?? true,
        startAt: dto.startAt ? new Date(dto.startAt) : null,
        endAt: dto.endAt ? new Date(dto.endAt) : null,
        sortOrder: dto.sortOrder ?? 0,
      },
      include: menuOfferInclude,
    });
    return toAdminMenuOfferResponse(created);
  }

  async update(id: string, dto: MenuOfferDto): Promise<AdminMenuOfferResponseDto> {
    const existing = await this.findOrThrow(id);
    if (dto.menuItemId !== existing.menuItemId) {
      await this.assertMenuItemExists(dto.menuItemId);
    }
    this.assertValidDateRange(dto.startAt, dto.endAt);

    const updated = await this.prisma.menuOffer.update({
      where: { id },
      data: {
        menuItemId: dto.menuItemId,
        imageUrl: dto.imageUrl,
        title: dto.title ?? null,
        description: dto.description ?? null,
        isActive: dto.isActive ?? existing.isActive,
        startAt: dto.startAt ? new Date(dto.startAt) : null,
        endAt: dto.endAt ? new Date(dto.endAt) : null,
        sortOrder: dto.sortOrder ?? existing.sortOrder,
      },
      include: menuOfferInclude,
    });
    return toAdminMenuOfferResponse(updated);
  }

  /**
   * Hard delete — mirrors NotificationCampaign (the closest existing
   * marketing-content model with a real DELETE endpoint); MenuOffer has no
   * deletedAt column. Only ever removes the offer row itself — the FK is a
   * plain reference in the other direction, so the linked MenuItem is never
   * touched.
   */
  async remove(id: string): Promise<void> {
    await this.findOrThrow(id);
    await this.prisma.menuOffer.delete({ where: { id } });
  }

  private async findOrThrow(id: string) {
    const offer = await this.prisma.menuOffer.findUnique({ where: { id } });
    if (!offer) {
      throw new NotFoundException({
        message: 'Menu offer not found',
        code: 'MENU_OFFER_NOT_FOUND',
      });
    }
    return offer;
  }

  private async assertMenuItemExists(menuItemId: string): Promise<void> {
    const item = await this.prisma.menuItem.findFirst({
      where: { id: menuItemId, deletedAt: null },
    });
    if (!item) {
      throw new UnprocessableEntityException({
        message: 'Menu item does not exist',
        code: 'INVALID_MENU_ITEM',
      });
    }
  }

  private assertValidDateRange(startAt: string | undefined, endAt: string | undefined): void {
    if (startAt && endAt && new Date(endAt) < new Date(startAt)) {
      throw new UnprocessableEntityException({
        message: 'endAt cannot precede startAt',
        code: 'MENU_OFFER_INVALID_DATE_RANGE',
      });
    }
  }
}
