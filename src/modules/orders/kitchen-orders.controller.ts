import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { OrdersService } from './orders.service';

/** Read-only order-ticket view for kitchen staff — no status-change routes here by design. */
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
}
