import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/** Shared shape for both customer and admin login (identical request contract). */
export class LoginDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password!: string;
}
