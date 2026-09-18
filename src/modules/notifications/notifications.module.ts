import { Module } from '@nestjs/common';
import { firebaseAdminProvider, FIREBASE_ADMIN_APP } from './firebase-admin.provider';
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
  // FIREBASE_ADMIN_APP is exported alongside NotificationsService so
  // AuthModule can verify Google/Firebase ID tokens through the SAME
  // initialized Admin app FCM already uses — no duplicate app, no second
  // service-account credential.
  exports: [NotificationsService, FIREBASE_ADMIN_APP],
})
export class NotificationsModule {}
