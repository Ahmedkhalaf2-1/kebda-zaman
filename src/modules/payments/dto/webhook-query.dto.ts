import { IsNotEmpty, IsString } from 'class-validator';

/** `?provider=<name>` routes the webhook to the matching PaymentProvider (plan §10.1 registry). */
export class WebhookQueryDto {
  @IsString()
  @IsNotEmpty()
  provider!: string;
}
