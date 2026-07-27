import { Body, Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { OrdersService } from './orders.service';
import { CheckoutDto } from './dto/checkout.dto';

/** Primary checkout path, as explicitly specified for this phase — same handler as POST /orders. */
@Controller({ path: 'checkout', version: '1' })
export class CheckoutController {
  constructor(private readonly ordersService: OrdersService) {}

  @Roles('CUSTOMER')
  @HttpCode(HttpStatus.CREATED)
  @Post()
  checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CheckoutDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.ordersService.checkout(user.id, dto, idempotencyKey, user.isGuest);
  }
}
