import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { CustomersService } from './customers.service';
import { ListCustomersDto } from './dto/list-customers.dto';
import { UpdateCustomerStatusDto } from './dto/update-customer-status.dto';

@Roles('ADMIN')
@Controller({ path: 'admin/customers', version: '1' })
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  list(@Query() query: ListCustomersDto) {
    return this.customersService.list(query);
  }

  @Get(':id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.customersService.getById(id);
  }

  @Patch(':id/status')
  updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerStatusDto) {
    return this.customersService.updateStatus(id, dto);
  }
}
