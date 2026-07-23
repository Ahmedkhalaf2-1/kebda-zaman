import { IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class ValidatePromoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code!: string;

  // Accepted per the API contract but ignored for the final calculation —
  // the server always prices from the caller's own current cart (plan §4.10).
  @IsOptional()
  @IsNumber()
  subtotal?: number;
}
