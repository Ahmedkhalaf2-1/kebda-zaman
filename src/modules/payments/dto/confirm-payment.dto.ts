import { IsNotEmpty, IsString } from 'class-validator';

/** The Moyasar payment id the Flutter SDK just created client-side — never trusted as-is, re-verified server-side against Moyasar before anything is persisted. */
export class ConfirmPaymentDto {
  @IsString()
  @IsNotEmpty()
  providerPaymentId!: string;
}
