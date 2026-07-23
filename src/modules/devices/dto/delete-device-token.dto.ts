import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class DeleteDeviceTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token!: string;
}
