import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { AdminNotificationsService } from './admin-notifications.service';
import { ListAdminNotificationsDto } from './dto/list-admin-notifications.dto';

@Roles('ADMIN')
@Controller({ path: 'admin/notifications', version: '1' })
export class AdminNotificationsController {
  constructor(private readonly adminNotificationsService: AdminNotificationsService) {}

  @Get()
  list(@Query() query: ListAdminNotificationsDto) {
    return this.adminNotificationsService.list(query);
  }

  @Get('unread-count')
  unreadCount() {
    return this.adminNotificationsService.unreadCount();
  }

  @Patch('read-all')
  markAllAsRead() {
    return this.adminNotificationsService.markAllAsRead();
  }

  @Patch(':id/read')
  markAsRead(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminNotificationsService.markAsRead(id);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete()
  async deleteAll(): Promise<void> {
    await this.adminNotificationsService.deleteAll();
  }
}
