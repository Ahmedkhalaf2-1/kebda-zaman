import { MenuItem, MenuOffer } from '@prisma/client';
import { MenuItemSummaryResponseDto, toMenuItemSummaryResponse } from './menu-item-response.mapper';

export type MenuOfferWithMenuItem = MenuOffer & { menuItem: MenuItem };

/**
 * Public shape (GET /menu-offers). Deliberately omits isActive/startAt/endAt
 * — visibility is already filtered server-side by MenuOffersService.listVisible,
 * so a customer client never needs to re-derive it — and createdAt/updatedAt
 * (admin-only bookkeeping). `menuItem` is always present (never soft-deleted):
 * MenuOffersService.listVisible already filters to offers whose linked
 * MenuItem is not soft-deleted, so this is safe to expose un-nulled.
 */
export interface MenuOfferResponseDto {
  id: string;
  imageUrl: string;
  menuItemId: string;
  title: string | null;
  description: string | null;
  sortOrder: number;
  menuItem: MenuItemSummaryResponseDto;
}

export function toMenuOfferResponse(offer: MenuOfferWithMenuItem): MenuOfferResponseDto {
  return {
    id: offer.id,
    imageUrl: offer.imageUrl,
    menuItemId: offer.menuItemId,
    title: offer.title,
    description: offer.description,
    sortOrder: offer.sortOrder,
    menuItem: toMenuItemSummaryResponse(offer.menuItem),
  };
}

/**
 * Admin view: adds the scheduling/activation fields the customer response
 * hides. `menuItem` may reflect a since-soft-deleted or unavailable item (the
 * admin list is not filtered the way the public endpoint is) so admins can
 * spot and fix stale offers.
 */
export interface AdminMenuOfferResponseDto extends MenuOfferResponseDto {
  isActive: boolean;
  startAt: string | null;
  endAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toAdminMenuOfferResponse(offer: MenuOfferWithMenuItem): AdminMenuOfferResponseDto {
  return {
    ...toMenuOfferResponse(offer),
    isActive: offer.isActive,
    startAt: offer.startAt?.toISOString() ?? null,
    endAt: offer.endAt?.toISOString() ?? null,
    createdAt: offer.createdAt.toISOString(),
    updatedAt: offer.updatedAt.toISOString(),
  };
}
