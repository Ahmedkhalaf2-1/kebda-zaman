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
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { FavoritesService } from './favorites.service';
import { AddFavoriteDto } from './dto/add-favorite.dto';

@Roles('CUSTOMER')
@Controller({ path: 'me/favorites', version: '1' })
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.favoritesService.list(user.id);
  }

  @HttpCode(HttpStatus.CREATED)
  @Post()
  add(@CurrentUser() user: AuthenticatedUser, @Body() dto: AddFavoriteDto) {
    return this.favoritesService.add(user.id, dto.menuItemId);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':menuItemId')
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('menuItemId', ParseUUIDPipe) menuItemId: string,
  ) {
    await this.favoritesService.remove(user.id, menuItemId);
  }
}
