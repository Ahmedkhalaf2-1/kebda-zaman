import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';

@Module({
  imports: [AuthModule],
  controllers: [DriversController],
  providers: [DriversService],
})
export class DriversModule {}
