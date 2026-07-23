import { Inject, Injectable, Logger } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import type { App } from 'firebase-admin/app';
import { getMessaging, type SendResponse } from 'firebase-admin/messaging';
import { PrismaService } from '../../prisma/prisma.service';
import { FIREBASE_ADMIN_APP } from './firebase-admin.provider';
import {
  AppNotificationPayload,
  buildOrderStatusPayload,
  toFcmDataPayload,
} from './notification-payload';

export interface SendResult {
  successCount: number;
  failureCount: number;
  invalidTokens: string[];
}

/** FCM error codes that mean the token is permanently dead (plan §9.3). */
const INVALID_TOKEN_ERROR_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
]);

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(FIREBASE_ADMIN_APP) private readonly firebaseApp: App | null,
    private readonly prisma: PrismaService,
  ) {}

  /** False in local/test environments with no Firebase credentials configured. */
  get isEnabled(): boolean {
    return this.firebaseApp !== null;
  }

  /**
   * Sends one data-only message to every token, then deactivates any token
   * FCM reports as permanently invalid (plan §9.3 "invalid token cleanup") —
   * never deletes the row outright, so the device/user association and send
   * history stay auditable.
   */
  async sendToTokens(tokens: string[], payload: AppNotificationPayload): Promise<SendResult> {
    if (tokens.length === 0) {
      return { successCount: 0, failureCount: 0, invalidTokens: [] };
    }
    if (!this.firebaseApp) {
      this.logger.warn('Firebase Admin not configured — skipping FCM send (no-op).');
      return { successCount: 0, failureCount: tokens.length, invalidTokens: [] };
    }

    const response = await getMessaging(this.firebaseApp).sendEachForMulticast({
      tokens,
      data: toFcmDataPayload(payload),
    });

    const invalidTokens: string[] = [];
    response.responses.forEach((result: SendResponse, index: number) => {
      if (!result.success && result.error && INVALID_TOKEN_ERROR_CODES.has(result.error.code)) {
        invalidTokens.push(tokens[index]);
      }
    });

    if (invalidTokens.length > 0) {
      await this.prisma.deviceToken.updateMany({
        where: { token: { in: invalidTokens } },
        data: { isActive: false },
      });
    }

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      invalidTokens,
    };
  }

  /**
   * Notification-sending infrastructure for order-status changes (plan
   * Phase 6 DoD). Not wired to any status-mutation endpoint yet — that
   * trigger belongs to the admin status API (Phase 7) and is intentionally
   * not built here.
   */
  async sendOrderStatusNotification(order: {
    id: string;
    userId: string;
    status: OrderStatus;
  }): Promise<SendResult> {
    const payload = buildOrderStatusPayload(order.id, order.status);
    if (!payload) {
      return { successCount: 0, failureCount: 0, invalidTokens: [] };
    }

    const devices = await this.prisma.deviceToken.findMany({
      where: { userId: order.userId, isActive: true },
      select: { token: true },
    });

    return this.sendToTokens(
      devices.map((device) => device.token),
      payload,
    );
  }
}
