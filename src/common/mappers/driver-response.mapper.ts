import { User } from '@prisma/client';

/** Public API shape for an admin-managed DRIVER account. Mirrors StaffResponseDto's
 * conventions (never leaks passwordHash) but is its own type since drivers carry no
 * `role` discriminant (a driver is always DRIVER) and gain fields (e.g. vehicle info)
 * are expected to diverge from staff over time. */
export interface DriverResponseDto {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
}

export function toDriverResponse(user: User): DriverResponseDto {
  return {
    id: user.id,
    name: user.fullName,
    email: user.email,
    phone: user.phone,
    // Reuses the existing soft-delete column — deactivating a driver sets
    // deletedAt, which already blocks login/refresh with zero new columns;
    // ActiveDriverGuard additionally blocks a still-valid access token.
    isActive: user.deletedAt === null,
    createdAt: user.createdAt.toISOString(),
  };
}
