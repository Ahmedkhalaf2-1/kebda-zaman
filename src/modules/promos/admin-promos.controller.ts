import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { PromosService } from './promos.service';
import { PromoDto } from './dto/promo.dto';

@Roles('ADMIN')
@Controller({ path: 'admin/promos', version: '1' })
export class AdminPromosController {
  constructor(private readonly promosService: PromosService) {}

  @Get()
  list() {
    return this.promosService.adminList();
  }

  @Post()
  create(@Body() dto: PromoDto) {
    return this.promosService.create(dto);
  }

  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PromoDto) {
    return this.promosService.update(id, dto);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.promosService.remove(id);
  }
}
