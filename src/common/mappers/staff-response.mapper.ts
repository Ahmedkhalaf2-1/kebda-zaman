import { User } from '@prisma/client';

/** Public API shape for an admin-managed cashier account. */
export interface StaffResponseDto {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
}

export function toStaffResponse(user: User): StaffResponseDto {
  return {
    id: user.id,
    name: user.fullName,
    email: user.email,
    phone: user.phone,
    // Reuses the existing soft-delete column: deactivating a cashier sets
    // deletedAt, which already blocks login (auth.service) and refresh
    // (token.service) with zero new columns/logic.
    isActive: user.deletedAt === null,
    createdAt: user.createdAt.toISOString(),
  };
}
