import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { OrdersService } from './orders.service';
import { SetPreparationTimeDto } from './dto/set-preparation-time.dto';

/** Kitchen ticket view + manual prep-time entry for kitchen staff. The class-level
 * @Roles('KITCHEN') covers the read-only ticket routes below; the preparation-time
 * route overrides it with a method-level @Roles(...) (RolesGuard prefers handler
 * metadata over class metadata) to additionally admit ADMIN, without widening
 * listOrders/getOrder. */
@Roles('KITCHEN')
@Controller({ path: 'kitchen/orders', version: '1' })
export class KitchenOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  listOrders() {
    return this.ordersService.kitchenListOrders();
  }

  @Get(':id')
  getOrder(@Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.kitchenGetOrder(id);
  }

  @Roles('KITCHEN', 'ADMIN')
  @Patch(':id/preparation-time')
  setPreparationTime(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPreparationTimeDto) {
    return this.ordersService.setPreparationTime(id, dto.minutes);
  }
}
