import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global data-access module. A single PrismaService instance is shared app-wide.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
