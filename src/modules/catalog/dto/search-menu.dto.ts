import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SearchMenuDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  q!: string;
}
