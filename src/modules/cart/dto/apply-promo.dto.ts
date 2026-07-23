import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ApplyPromoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code!: string;
}
