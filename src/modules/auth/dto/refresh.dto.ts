import { IsOptional, IsString, MinLength } from 'class-validator';

export class RefreshDto {
  @IsString()
  @MinLength(1)
  refreshToken!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  deviceToken?: string;
}
