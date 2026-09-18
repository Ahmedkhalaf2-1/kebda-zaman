import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { OrdersService } from './orders.service';
import { DriverLocationService } from './driver-location.service';
import { CheckoutDto } from './dto/checkout.dto';
import { ListOrdersDto } from './dto/list-orders.dto';

@Controller({ path: 'orders', version: '1' })
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly driverLocationService: DriverLocationService,
  ) {}

  @Roles('CUSTOMER')
  @HttpCode(HttpStatus.CREATED)
  @Post()
  checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CheckoutDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.ordersService.checkout(user.id, dto, idempotencyKey, user.isGuest);
  }

  @Get()
  listOrders(@CurrentUser() user: AuthenticatedUser, @Query() query: ListOrdersDto) {
    return this.ordersService.listOrders(user.id, query);
  }

  @Get(':id')
  getOrder(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.getOrder(user.id, id);
  }

  @Get(':id/status')
  getOrderStatus(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.getOrderStatus(user.id, id);
  }

  /** Phase 2 live tracking — ownership-scoped like getOrder/getOrderStatus
   * above (no `@Roles()`: open to any authenticated owner, guests included,
   * same convention as its siblings). `no-store` since this can return live
   * GPS coordinates — never cached by a browser, proxy, or CDN. */
  @Header('Cache-Control', 'no-store')
  @Get(':id/tracking')
  getOrderTracking(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.driverLocationService.getCustomerTracking(user.id, id);
  }
}
