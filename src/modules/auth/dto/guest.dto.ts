import { IsOptional, IsString, MaxLength } from 'class-validator';

export class GuestDto {
  // Accepted per the API contract but not yet processed — device/cart
  // association for guests is a later-phase (Cart/Devices) concern.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceId?: string;
}
