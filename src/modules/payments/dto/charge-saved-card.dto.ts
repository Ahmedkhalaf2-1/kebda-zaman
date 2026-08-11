import { IsOptional, IsString, Length } from 'class-validator';

/** CVC is optional per Moyasar (some issuers require it for token/recurring charges) — never a full card number, never stored. */
export class ChargeSavedCardDto {
  @IsOptional()
  @IsString()
  @Length(3, 4)
  cvc?: string;
}
