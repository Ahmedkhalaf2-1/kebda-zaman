import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { FRONTEND_STATUS_TO_ORDER_STATUS } from '../../common/mappers/order-response.mapper';
import { OrdersService } from './orders.service';
import { AdminListOrdersDto } from './dto/admin-list-orders.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';

@Roles('ADMIN')
@Controller({ path: 'admin/orders', version: '1' })
export class AdminOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  listOrders(@Query() query: AdminListOrdersDto) {
    return this.ordersService.adminListOrders(query);
  }

  @Get(':id')
  getOrder(@Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.adminGetOrder(id);
  }

  @Patch(':id/status')
  updateStatus(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.ordersService.updateOrderStatus(
      id,
      FRONTEND_STATUS_TO_ORDER_STATUS[dto.status],
      admin.id,
      dto.note,
    );
  }
}
