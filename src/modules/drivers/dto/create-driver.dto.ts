import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Admin-only: creates a DRIVER account. No `role`/`isActive` field exists here —
 * every driver created through this endpoint is DRIVER + active by construction. */
export class CreateDriverDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}
