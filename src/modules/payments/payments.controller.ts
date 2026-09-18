import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SENSITIVE_ROUTE_THROTTLE } from '../../common/constants/sensitive-route-throttle.const';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaymentsService } from './payments.service';
import { CreateIntentDto } from './dto/create-intent.dto';
import { WebhookQueryDto } from './dto/webhook-query.dto';
import { ConfirmPaymentDto } from './dto/confirm-payment.dto';
import { ChargeSavedCardDto } from './dto/charge-saved-card.dto';

@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Roles('CUSTOMER')
  @Post('intent')
  createIntent(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateIntentDto) {
    return this.paymentsService.createIntent(user.id, dto);
  }

  // Registered ahead of `GET :id` below — a literal 'cards' segment would
  // otherwise be captured by the `:id` param route (Nest/Express match in
  // registration order for same-method overlapping paths).
  @Roles('CUSTOMER')
  @Get('cards')
  listSavedCards(@CurrentUser() user: AuthenticatedUser) {
    return this.paymentsService.listSavedCards(user.id);
  }

  @Roles('CUSTOMER')
  @Delete('cards/:id')
  deleteSavedCard(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.paymentsService.deleteSavedCard(user.id, id);
  }

  @Roles('CUSTOMER')
  @Post(':orderId/cards/:cardId/charge')
  chargeSavedCard(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Param('cardId', ParseUUIDPipe) cardId: string,
    @Body() dto: ChargeSavedCardDto,
  ) {
    return this.paymentsService.chargeSavedCard(user.id, orderId, cardId, dto.cvc);
  }

  // Flutter reports the Moyasar payment id it just created client-side (new
  // card flow) — never trusted as-is, PaymentsService re-verifies against
  // Moyasar before persisting anything.
  @Roles('CUSTOMER')
  @Post(':orderId/confirm')
  confirmCardPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: ConfirmPaymentDto,
  ) {
    return this.paymentsService.confirmCardPayment(user.id, orderId, dto.providerPaymentId);
  }

  @Get(':id')
  getPayment(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.paymentsService.getPayment(user, id);
  }

  // Public + signature-verified per provider (plan §10.2), not JWT-gated —
  // gateways call this directly. Raw-byte capture for HMAC verification is a
  // concern for whichever real provider is added later; the parsed JSON body
  // is re-serialized here as a stand-in until then.
  @Public()
  @Throttle(SENSITIVE_ROUTE_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @Post('webhook')
  webhook(
    @Query() query: WebhookQueryDto,
    @Headers() headers: Record<string, string>,
    @Body() body: unknown,
  ) {
    return this.paymentsService.processWebhook(query.provider, headers, JSON.stringify(body));
  }
}
