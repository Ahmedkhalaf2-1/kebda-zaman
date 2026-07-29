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

/** FCM multicast requests reject more than 500 registration tokens per call. */
const FCM_MULTICAST_BATCH_SIZE = 500;

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
   * Safe production/admin status surface (§6): booleans only — never the
   * service-account JSON, private keys, or access tokens that
   * `firebase-admin.provider.ts` reads. Lets an operator (or an admin
   * dashboard) see "FCM is unconfigured" instead of only discovering it when
   * a broadcast quietly reports FAILED.
   */
  getStatus(): { firebase: { configured: boolean; enabled: boolean } } {
    return { firebase: { configured: this.isEnabled, enabled: this.isEnabled } };
  }

  /**
   * Sends one data-only message to every token, then deactivates any token
   * FCM reports as permanently invalid (plan §9.3 "invalid token cleanup") —
   * never deletes the row outright, so the device/user association and send
   * history stay auditable.
   */
  async sendToTokens(tokens: string[], payload: AppNotificationPayload): Promise<SendResult> {
    return this.dispatch(tokens, { data: toFcmDataPayload(payload) });
  }

  /**
   * Admin Notification Center (Sprint 2). Recipients are every ADMIN's active
   * device — resolved fresh on each send (no cached/duplicated token list) via
   * the same `DeviceToken` table customer sends use, just filtered by the
   * owning `User.role`. Sends a `notification` block (so it renders even if
   * the admin app is killed) alongside the `data` block the app also uses for
   * in-app routing.
   */
  async sendAdminNewOrderNotification(params: {
    notificationId: string;
    orderId: string;
    orderNumber: string;
    customerName: string;
  }): Promise<SendResult> {
    const devices = await this.prisma.deviceToken.findMany({
      where: { isActive: true, user: { role: 'ADMIN' } },
      select: { token: true },
    });

    return this.dispatch(
      devices.map((device) => device.token),
      {
        notification: {
          title: 'New order received',
          body: `${params.customerName} placed order ${params.orderNumber}`,
        },
        data: {
          type: 'NEW_ORDER',
          notificationId: params.notificationId,
          orderId: params.orderId,
          orderNumber: params.orderNumber,
        },
      },
    );
  }

  /**
   * Shared FCM multicast + invalid-token cleanup core — every send path
   * (customer data-only pushes, admin notification+data pushes) goes through
   * this one place so there is exactly one piece of code that talks to
   * Firebase and exactly one piece of code that deactivates dead tokens.
   */
  private async dispatch(
    tokens: string[],
    message: { data: Record<string, string>; notification?: { title: string; body: string } },
  ): Promise<SendResult> {
    if (tokens.length === 0) {
      return { successCount: 0, failureCount: 0, invalidTokens: [] };
    }
    if (!this.firebaseApp) {
      this.logger.warn('Firebase Admin not configured — skipping FCM send (no-op).');
      return { successCount: 0, failureCount: tokens.length, invalidTokens: [] };
    }

    const batches: string[][] = [];
    for (let i = 0; i < tokens.length; i += FCM_MULTICAST_BATCH_SIZE) {
      batches.push(tokens.slice(i, i + FCM_MULTICAST_BATCH_SIZE));
    }

    let successCount = 0;
    let failureCount = 0;
    const invalidTokens = new Set<string>();

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batchTokens = batches[batchIndex];
      let response;
      try {
        response = await getMessaging(this.firebaseApp).sendEachForMulticast({
          tokens: batchTokens,
          data: message.data,
          ...(message.notification ? { notification: message.notification } : {}),
        });
      } catch (error) {
        // Only counts/indices — never token values or Firebase credentials.
        this.logger.error(
          `FCM batch ${batchIndex + 1}/${batches.length} failed (${successCount} succeeded / ` +
            `${failureCount} failed across prior batches): ${(error as Error).message}`,
        );
        throw error;
      }

      successCount += response.successCount;
      failureCount += response.failureCount;
      response.responses.forEach((result: SendResponse, index: number) => {
        if (!result.success && result.error && INVALID_TOKEN_ERROR_CODES.has(result.error.code)) {
          invalidTokens.add(batchTokens[index]);
        }
      });
    }

    const dedupedInvalidTokens = [...invalidTokens];
    if (dedupedInvalidTokens.length > 0) {
      await this.prisma.deviceToken.updateMany({
        where: { token: { in: dedupedInvalidTokens } },
        data: { isActive: false },
      });
    }

    this.logger.log(
      `Dispatched ${tokens.length} token(s) across ${batches.length} batch(es): ` +
        `${successCount} succeeded, ${failureCount} failed.`,
    );

    return {
      successCount,
      failureCount,
      invalidTokens: dedupedInvalidTokens,
    };
  }

  /**
   * Notification-sending for order-status changes (plan Phase 6 DoD), wired
   * from `OrdersService.updateOrderStatus`. Sends a `notification` block
   * (title/body) alongside the existing `data` block — unlike a
   * data-only message, this renders even if the customer's app is
   * backgrounded/killed, instead of depending entirely on a client-side
   * background handler running reliably. Goes through `dispatch` directly
   * (not `sendToTokens`, which stays data-only for campaigns) so this
   * change is scoped to order-status pushes only.
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

    return this.dispatch(
      devices.map((device) => device.token),
      {
        notification: { title: payload.title, body: payload.body },
        data: toFcmDataPayload(payload),
      },
    );
  }
}
