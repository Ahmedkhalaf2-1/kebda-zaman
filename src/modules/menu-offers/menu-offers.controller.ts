import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { MenuOffersService } from './menu-offers.service';

/** Public, read-only — customer Menu screen offer banners. No auth required. */
@Public()
@Controller({ path: 'menu-offers', version: '1' })
export class MenuOffersController {
  constructor(private readonly menuOffersService: MenuOffersService) {}

  @Get()
  list() {
    return this.menuOffersService.listVisible();
  }
}
