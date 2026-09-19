import { IsString, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  token!: string;

  // Same policy as RegisterDto.password (plan §5.1 password policy).
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}
