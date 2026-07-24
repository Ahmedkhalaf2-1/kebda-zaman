import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SENSITIVE_ROUTE_THROTTLE } from '../../common/constants/sensitive-route-throttle.const';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PromosService } from './promos.service';
import { ValidatePromoDto } from './dto/validate-promo.dto';

@Controller({ path: 'promos', version: '1' })
export class PromosController {
  constructor(private readonly promosService: PromosService) {}

  @Throttle(SENSITIVE_ROUTE_THROTTLE)
  @Post('validate')
  validate(@CurrentUser() user: AuthenticatedUser, @Body() dto: ValidatePromoDto) {
    return this.promosService.validate(user.id, dto);
  }
}
