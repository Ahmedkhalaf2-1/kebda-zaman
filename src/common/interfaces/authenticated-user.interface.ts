import { UserRole } from '@prisma/client';

/** Decoded access-token principal attached to `request.user` by JwtAccessGuard. */
export interface AuthenticatedUser {
  id: string;
  role: UserRole;
  isGuest: boolean;
  jti: string;
}
