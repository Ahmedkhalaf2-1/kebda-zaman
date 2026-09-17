import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ActiveDriverGuard } from '../../common/guards/active-driver.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { DRIVER_LOCATION_THROTTLE } from '../../common/constants/driver-location-throttle.const';
import { OrdersService } from './orders.service';
import { DriverLocationService } from './driver-location.service';
import { ListDriverOrdersDto } from './dto/list-driver-orders.dto';
import { UpdateDriverLocationDto } from './dto/update-driver-location.dto';

/** DRIVER-only delivery endpoints (Phase 1). `ActiveDriverGuard` closes a gap
 * global auth alone leaves open: an admin deactivating a driver mid-shift must
 * stop that driver's still-valid access token from working immediately, not
 * just block their next login/refresh — see the guard's doc comment.
 *
 * Route order matters here: `history` is a literal path segment and MUST be
 * registered before the `:id` route below it, or Nest would try to match
 * "history" as a UUID via `:id` first. */
@Roles('DRIVER')
@UseGuards(ActiveDriverGuard)
@Controller({ path: 'driver/orders', version: '1' })
export class DriverOrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly driverLocationService: DriverLocationService,
  ) {}

  @Get()
  listActive(@CurrentUser() driver: AuthenticatedUser, @Query() query: ListDriverOrdersDto) {
    return this.ordersService.driverListActiveOrders(driver.id, query);
  }

  @Get('history')
  listHistory(@CurrentUser() driver: AuthenticatedUser, @Query() query: ListDriverOrdersDto) {
    return this.ordersService.driverListHistory(driver.id, query);
  }

  @Get(':id')
  getOrder(@CurrentUser() driver: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.driverGetOrder(driver.id, id);
  }

  @Patch(':id/pickup')
  pickup(@CurrentUser() driver: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.driverStartDelivery(driver.id, id);
  }

  @Patch(':id/delivered')
  delivered(@CurrentUser() driver: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ordersService.driverMarkDelivered(driver.id, id);
  }

  /** Phase 2 live tracking. Own dedicated throttle (60 req/60s, see
   * DRIVER_LOCATION_THROTTLE) — the global default (100 req/60s across ALL
   * of a driver's traffic) isn't sized for a 5-10s GPS upload cadence.
   * Ownership/lifecycle/assignment-version enforcement all happens in
   * DriverLocationService — never trusts anything but the authenticated
   * `driver.id` from the access token and the `:id` route param. */
  @Throttle(DRIVER_LOCATION_THROTTLE)
  @Put(':id/location')
  recordLocation(
    @CurrentUser() driver: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDriverLocationDto,
  ) {
    return this.driverLocationService.recordLocation(driver.id, id, dto);
  }
}
