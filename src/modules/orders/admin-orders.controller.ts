import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { FRONTEND_STATUS_TO_ORDER_STATUS } from '../../common/mappers/order-response.mapper';
import { OrdersService } from './orders.service';
import { DriverLocationService } from './driver-location.service';
import { AdminListOrdersDto } from './dto/admin-list-orders.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { AssignDriverDto } from './dto/assign-driver.dto';

@Roles('ADMIN', 'CASHIER')
@Controller({ path: 'admin/orders', version: '1' })
export class AdminOrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly driverLocationService: DriverLocationService,
  ) {}

  @Get()
  listOrders(@Query() query: AdminListOrdersDto) {
    return this.ordersService.adminListOrders(query);
  }

  /** Counts only, no deletion — for the frontend's "wipe orders" confirmation
   * dialog. Declared before the `:id` route below so it isn't swallowed by
   * ParseUUIDPipe. */
  @Get('reset-preview')
  ordersResetPreview() {
    return this.ordersService.adminOrdersResetPreview();
  }

  /** ADMIN-only (not CASHIER) — permanently deletes every order. Refuses to
   * run once NODE_ENV=production (see OrdersService.assertResetAllowed);
   * this exists to clear test/demo data before launch, not for routine use. */
  @Roles('ADMIN')
  @Delete('reset')
  resetOrders() {
    return this.ordersService.adminResetOrders();
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

  /** ADMIN-only (not CASHIER, unlike the rest of this controller) — manual
   * driver assignment is an administrator responsibility per the plan. Also
   * used for reassignment: assigning a different driverId to an already-
   * assigned order simply overwrites it (see OrdersService.assignDriver). */
  @Roles('ADMIN')
  @Patch(':id/driver')
  assignDriver(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignDriverDto,
  ) {
    return this.ordersService.assignDriver(id, dto.driverId, admin.id);
  }

  @Roles('ADMIN')
  @Delete(':id/driver')
  unassignDriver(@CurrentUser() admin: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.assignDriver(id, null, admin.id);
  }

  /** Phase 2 live tracking. No role override — inherits ADMIN+CASHIER from
   * the class level, the same "authorized staff" bar as every other read on
   * this controller. `no-store` since this can return live GPS coordinates. */
  @Header('Cache-Control', 'no-store')
  @Get(':id/tracking')
  getOrderTracking(@Param('id', ParseUUIDPipe) id: string) {
    return this.driverLocationService.getAdminTracking(id);
  }
}
