import { Module } from '@nestjs/common';
import { MenuOffersController } from './menu-offers.controller';
import { AdminMenuOffersController } from './admin-menu-offers.controller';
import { MenuOffersService } from './menu-offers.service';

@Module({
  controllers: [MenuOffersController, AdminMenuOffersController],
  providers: [MenuOffersService],
})
export class MenuOffersModule {}
