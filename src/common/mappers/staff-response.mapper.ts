import { User } from '@prisma/client';
import { StaffRole } from '../../modules/staff/dto/staff-role';

/** Public API shape for an admin-managed staff account (cashier or kitchen). */
export interface StaffResponseDto {
  id: string;
  role: StaffRole;
  name: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
}

export function toStaffResponse(user: User): StaffResponseDto {
  return {
    id: user.id,
    role: user.role as StaffRole,
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
