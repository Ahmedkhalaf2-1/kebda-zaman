import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Only the raw Firebase ID token is accepted from the client — every identity
 * value (email, name, photo, uid, role) is derived exclusively from the
 * verified token server-side, never trusted from the request body.
 */
export class GoogleAuthDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  firebaseIdToken!: string;
}
