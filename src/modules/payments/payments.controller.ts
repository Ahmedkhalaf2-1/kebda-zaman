import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PaymentsService } from './payments.service';
import { CreateIntentDto } from './dto/create-intent.dto';
import { WebhookQueryDto } from './dto/webhook-query.dto';

@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Roles('CUSTOMER')
  @Post('intent')
  createIntent(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateIntentDto) {
    return this.paymentsService.createIntent(user.id, dto);
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
