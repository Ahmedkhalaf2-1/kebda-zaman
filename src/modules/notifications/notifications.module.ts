import { Module } from '@nestjs/common';
import { firebaseAdminProvider } from './firebase-admin.provider';
import { NotificationsService } from './notifications.service';
import { CampaignsService } from './campaigns.service';
import { CampaignsSchedulerService } from './campaigns-scheduler.service';
import { AdminNotificationsController } from './admin-notifications.controller';

@Module({
  controllers: [AdminNotificationsController],
  providers: [
    firebaseAdminProvider,
    NotificationsService,
    CampaignsService,
    CampaignsSchedulerService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
