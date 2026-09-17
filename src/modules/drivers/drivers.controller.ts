import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { DriversService } from './drivers.service';
import { CreateDriverDto } from './dto/create-driver.dto';
import { UpdateDriverDto } from './dto/update-driver.dto';
import { ListDriversDto } from './dto/list-drivers.dto';

/** Admin-only driver account management (Phase 1 of the delivery-driver system).
 * No public registration path exists for DRIVER — every account here is created
 * by an authenticated ADMIN, same convention as StaffController. */
@Roles('ADMIN')
@Controller({ path: 'admin/drivers', version: '1' })
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Get()
  list(@Query() query: ListDriversDto) {
    return this.driversService.list(query);
  }

  @Get(':id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.driversService.getById(id);
  }

  @Post()
  create(@Body() dto: CreateDriverDto) {
    return this.driversService.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDriverDto) {
    return this.driversService.update(id, dto);
  }
}
