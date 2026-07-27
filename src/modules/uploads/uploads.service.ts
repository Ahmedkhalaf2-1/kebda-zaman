import { mkdirSync } from 'node:fs';
import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { STATIC_UPLOADS_PREFIX } from './uploads.constants';

export interface UploadImageResponseDto {
  imageUrl: string;
}

/**
 * Generic, entity-agnostic file storage: any admin feature (menu items,
 * categories, promos, ...) that needs an image asks this service for a
 * public URL rather than managing storage/paths itself.
 */
@Injectable()
export class UploadsService implements OnModuleInit {
  constructor(private readonly config: ConfigService) {}

  /** Ensures the storage directory exists before the server starts accepting requests. */
  onModuleInit(): void {
    mkdirSync(this.uploadDir(), { recursive: true });
  }

  uploadDir(): string {
    return this.config.get<string>('uploads.dir')!;
  }

  buildResponse(file: Express.Multer.File | undefined): UploadImageResponseDto {
    if (!file) {
      throw new BadRequestException({
        message: 'No file was uploaded. Send it as multipart/form-data under the "file" field.',
        code: 'FILE_REQUIRED',
      });
    }

    const publicBaseUrl = this.config.get<string>('uploads.publicBaseUrl')!;
    return { imageUrl: `${publicBaseUrl}${STATIC_UPLOADS_PREFIX}/${file.filename}` };
  }
}
