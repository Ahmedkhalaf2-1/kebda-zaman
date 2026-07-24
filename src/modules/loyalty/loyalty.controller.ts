import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { LoyaltyService, assertNotGuest } from './loyalty.service';
import { RedeemDto } from './dto/redeem.dto';

/** Plan §4.14. `role=CUSTOMER` alone doesn't exclude guests (guests are role=CUSTOMER, isGuest=true) — checked explicitly. */
@Roles('CUSTOMER')
@Controller({ path: 'me/loyalty', version: '1' })
export class LoyaltyController {
  constructor(private readonly loyaltyService: LoyaltyService) {}

  @Get()
  getAccount(@CurrentUser() user: AuthenticatedUser) {
    assertNotGuest(user.isGuest);
    return this.loyaltyService.getAccount(user.id);
  }

  @Get('transactions')
  listTransactions(@CurrentUser() user: AuthenticatedUser) {
    assertNotGuest(user.isGuest);
    return this.loyaltyService.listTransactions(user.id);
  }

  @Post('redeem')
  redeem(@CurrentUser() user: AuthenticatedUser, @Body() dto: RedeemDto) {
    assertNotGuest(user.isGuest);
    return this.loyaltyService.redeem(user.id, dto);
  }
}
