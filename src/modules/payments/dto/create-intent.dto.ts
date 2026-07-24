import { IsUUID } from 'class-validator';

export class CreateIntentDto {
  @IsUUID()
  orderId!: string;
}
