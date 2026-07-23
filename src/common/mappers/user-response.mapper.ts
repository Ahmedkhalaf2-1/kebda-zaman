import { User, UserRole } from '@prisma/client';

/**
 * Public API shape for a User. Field-picked explicitly (never spread) so
 * passwordHash can never leak, and `fullName` is exposed as `name` to match
 * the existing Flutter `User` model (plan §3.6 / BACKEND_IMPLEMENTATION_PLAN D2).
 */
export interface UserResponseDto {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  role: UserRole;
  isGuest: boolean;
  locale: string;
  createdAt: string;
}

export function toUserResponse(user: User): UserResponseDto {
  return {
    id: user.id,
    name: user.fullName,
    email: user.email,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    role: user.role,
    isGuest: user.isGuest,
    locale: user.locale,
    createdAt: user.createdAt.toISOString(),
  };
}
