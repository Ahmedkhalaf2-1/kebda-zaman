import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Firebase ID token minted after Sign in with Apple. Identity fields are
 * always derived from the verified token server-side.
 */
export class AppleAuthDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  firebaseIdToken!: string;
}
