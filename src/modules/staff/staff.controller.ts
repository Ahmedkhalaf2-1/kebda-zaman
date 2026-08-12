import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional } from 'class-validator';
import { Roles } from '../../common/decorators/roles.decorator';
import { StaffService } from './staff.service';
import { CreateStaffDto } from './dto/create-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { STAFF_ROLES, StaffRole } from './dto/staff-role';

class ListStaffQueryDto {
  @IsOptional()
  @IsIn(STAFF_ROLES)
  role?: StaffRole;
}

/** Owner-only staff account management (cashier + kitchen). */
@Roles('ADMIN')
@Controller({ path: 'admin/staff', version: '1' })
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Get()
  list(@Query() query: ListStaffQueryDto) {
    return this.staffService.list(query.role);
  }

  @Post()
  create(@Body() dto: CreateStaffDto) {
    return this.staffService.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStaffDto) {
    return this.staffService.update(id, dto);
  }
}
