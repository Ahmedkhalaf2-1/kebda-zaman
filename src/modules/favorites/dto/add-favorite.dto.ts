import { IsUUID } from 'class-validator';

export class AddFavoriteDto {
  @IsUUID()
  menuItemId!: string;
}
