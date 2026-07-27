import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BadRequestException, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { AdminUploadsController } from './admin-uploads.controller';
import { UploadsService } from './uploads.service';
import { ALLOWED_IMAGE_EXTENSIONS, ALLOWED_IMAGE_MIME_TYPES } from './uploads.constants';

@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        storage: diskStorage({
          destination: config.get<string>('uploads.dir')!,
          // Unique per upload — collisions are practically impossible, so an
          // existing file is never overwritten.
          filename: (_req, file, callback) => {
            callback(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`);
          },
        }),
        limits: {
          fileSize: (config.get<number>('uploads.maxFileSizeMb') ?? 5) * 1024 * 1024,
        },
        fileFilter: (_req, file, callback) => {
          const ext = extname(file.originalname).toLowerCase();
          const isAllowedExt = (ALLOWED_IMAGE_EXTENSIONS as readonly string[]).includes(ext);
          const isAllowedMime = (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(
            file.mimetype,
          );
          if (!isAllowedExt || !isAllowedMime) {
            callback(
              new BadRequestException({
                message: `Unsupported image type. Allowed types: ${ALLOWED_IMAGE_EXTENSIONS.join(', ')}`,
                code: 'INVALID_FILE_TYPE',
              }),
              false,
            );
            return;
          }
          callback(null, true);
        },
      }),
    }),
  ],
  controllers: [AdminUploadsController],
  providers: [UploadsService],
  exports: [UploadsService],
})
export class UploadsModule {}
