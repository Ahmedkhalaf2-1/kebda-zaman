import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '../../common/decorators/roles.decorator';
import { UploadsService, UploadImageResponseDto } from './uploads.service';

/**
 * Single, reusable image upload endpoint for every admin feature (menu items,
 * categories, promos, notification campaigns, ...). Callers upload once here
 * and pass the returned imageUrl into whichever entity's create/update body.
 */
@Roles('ADMIN')
@Controller({ path: 'admin/uploads', version: '1' })
export class AdminUploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('image')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  uploadImage(@UploadedFile() file: Express.Multer.File): UploadImageResponseDto {
    return this.uploadsService.buildResponse(file);
  }
}
