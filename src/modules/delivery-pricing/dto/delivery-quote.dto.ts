import { IsNumber, Max, Min } from 'class-validator';

/** Only the customer's destination — origin (RestaurantSettings), travel
 * mode, and every money figure are always server-resolved, never accepted
 * from the client. */
export class DeliveryQuoteDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;
}
