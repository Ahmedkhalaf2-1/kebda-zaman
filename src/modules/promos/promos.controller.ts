import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { PromosService } from './promos.service';
import { ValidatePromoDto } from './dto/validate-promo.dto';

@Controller({ path: 'promos', version: '1' })
export class PromosController {
  constructor(private readonly promosService: PromosService) {}

  @Post('validate')
  validate(@CurrentUser() user: AuthenticatedUser, @Body() dto: ValidatePromoDto) {
    return this.promosService.validate(user.id, dto);
  }
}
