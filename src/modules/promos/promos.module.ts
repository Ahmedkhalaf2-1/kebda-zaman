import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { PricingModule } from '../pricing/pricing.module';
import { PromosController } from './promos.controller';
import { AdminPromosController } from './admin-promos.controller';
import { PromosService } from './promos.service';

@Module({
  imports: [CartModule, PricingModule],
  controllers: [PromosController, AdminPromosController],
  providers: [PromosService],
})
export class PromosModule {}
