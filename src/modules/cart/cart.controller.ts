import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { CartService } from './cart.service';
import { AddCartItemDto } from './dto/add-cart-item.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';
import { ApplyPromoDto } from './dto/apply-promo.dto';

/** Access required for every route (guest tokens qualify — see plan §4.9 "guest-ok"). */
@Controller({ path: 'cart', version: '1' })
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  getCart(@CurrentUser() user: AuthenticatedUser) {
    return this.cartService.getCart(user.id);
  }

  @Post('items')
  addItem(@CurrentUser() user: AuthenticatedUser, @Body() dto: AddCartItemDto) {
    return this.cartService.addItem(user.id, dto);
  }

  @Put('items/:id')
  updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCartItemDto,
  ) {
    return this.cartService.updateItem(user.id, id, dto);
  }

  @Delete('items/:id')
  removeItem(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.cartService.removeItem(user.id, id);
  }

  @Post('apply-promo')
  applyPromo(@CurrentUser() user: AuthenticatedUser, @Body() dto: ApplyPromoDto) {
    return this.cartService.applyPromo(user.id, dto.code);
  }

  @Delete('promo')
  removePromo(@CurrentUser() user: AuthenticatedUser) {
    return this.cartService.removePromo(user.id);
  }

  @Delete()
  clearCart(@CurrentUser() user: AuthenticatedUser) {
    return this.cartService.clearCart(user.id);
  }
}
