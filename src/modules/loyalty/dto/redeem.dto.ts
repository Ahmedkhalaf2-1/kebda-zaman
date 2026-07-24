import { IsString, IsNotEmpty } from 'class-validator';

export class RedeemDto {
  @IsString()
  @IsNotEmpty()
  rewardId!: string;
}
