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
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { CampaignsService } from './campaigns.service';
import { CampaignDto, ListCampaignsDto, ScheduleCampaignDto } from './dto/campaign.dto';

@Roles('ADMIN')
@Controller({ path: 'admin/notifications', version: '1' })
export class AdminNotificationsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @HttpCode(HttpStatus.CREATED)
  @Post('send')
  send(@CurrentUser() admin: AuthenticatedUser, @Body() dto: CampaignDto) {
    return this.campaignsService.send(admin.id, dto);
  }

  @HttpCode(HttpStatus.CREATED)
  @Post('schedule')
  schedule(@CurrentUser() admin: AuthenticatedUser, @Body() dto: ScheduleCampaignDto) {
    return this.campaignsService.schedule(admin.id, dto);
  }

  @Get('campaigns')
  listCampaigns(@Query() query: ListCampaignsDto) {
    return this.campaignsService.listCampaigns(query);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('campaigns/:id')
  async removeCampaign(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.campaignsService.remove(id);
  }
}
