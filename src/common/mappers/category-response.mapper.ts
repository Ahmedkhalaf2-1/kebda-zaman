import { Category } from '@prisma/client';

/** Matches the Flutter `Category` model 1:1 (plan §2.4 fields, no renames needed). */
export interface CategoryResponseDto {
  id: string;
  nameAr: string;
  nameEn: string;
  iconUrl: string | null;
  displayOrder: number;
}

export function toCategoryResponse(category: Category): CategoryResponseDto {
  return {
    id: category.id,
    nameAr: category.nameAr,
    nameEn: category.nameEn,
    iconUrl: category.iconUrl,
    displayOrder: category.displayOrder,
  };
}

/** Admin view: adds isActive, which the public catalog never exposes (it only ever lists active ones). */
export interface AdminCategoryResponseDto extends CategoryResponseDto {
  isActive: boolean;
}

export function toAdminCategoryResponse(category: Category): AdminCategoryResponseDto {
  return { ...toCategoryResponse(category), isActive: category.isActive };
}
