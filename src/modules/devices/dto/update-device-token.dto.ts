import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { DevicePlatform } from '@prisma/client';

export class UpdateDeviceTokenDto {
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  oldToken?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token!: string;

  @IsEnum(DevicePlatform)
  platform!: DevicePlatform;
}
