import { Body, Controller, Delete, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { DevicesService } from './devices.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { UpdateDeviceTokenDto } from './dto/update-device-token.dto';
import { DeleteDeviceTokenDto } from './dto/delete-device-token.dto';

/** Access required (guest-ok — guest sessions already carry a real access token). */
@Controller({ path: 'devices', version: '1' })
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  @HttpCode(HttpStatus.CREATED)
  @Post('register')
  register(@CurrentUser() user: AuthenticatedUser, @Body() dto: RegisterDeviceDto) {
    return this.devicesService.register(user.id, dto);
  }

  @Put('token')
  updateToken(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateDeviceTokenDto) {
    return this.devicesService.updateToken(user.id, dto);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('token')
  async deleteToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeleteDeviceTokenDto,
  ): Promise<void> {
    await this.devicesService.deleteToken(user.id, dto);
  }
}
