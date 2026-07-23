import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { SettingsService } from './settings.service';

@Public()
@Controller({ path: 'settings', version: '1' })
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  getPublicSettings() {
    return this.settingsService.getPublicSettings();
  }
}
