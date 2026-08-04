import { readFileSync } from 'node:fs';
import { FactoryProvider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { App, cert, initializeApp, ServiceAccount } from 'firebase-admin/app';

export const FIREBASE_ADMIN_APP = 'FIREBASE_ADMIN_APP';

const logger = new Logger('FirebaseAdmin');

/**
 * Server-only Firebase Admin SDK init (plan §9.1). Credentials come from
 * FIREBASE_SERVICE_ACCOUNT_PATH (a file mounted as a secret) or inline
 * FIREBASE_SERVICE_ACCOUNT_JSON — never hardcoded, never logged, never
 * returned by any endpoint. When neither is configured (local/test), FCM
 * sending is disabled rather than failing app boot.
 */
export function createFirebaseAdminApp(config: ConfigService): App | null {
  const projectId = config.get<string>('firebase.projectId');
  const serviceAccountPath = config.get<string>('firebase.serviceAccountPath');
  const serviceAccountJson = config.get<string>('firebase.serviceAccountJson');
  const isProduction = config.get<string>('nodeEnv') === 'production';

  if (!serviceAccountPath && !serviceAccountJson) {
    const message =
      'No Firebase credentials configured — FCM sending is disabled (safe no-op mode).';
    // In production this is a misconfiguration worth paging on, not routine
    // background noise — logged at 'error' so it surfaces in alerting.
    // Boot still succeeds (§1): a missing FCM provider must never take the
    // API down. The safe/unconfigured state is also exposed via
    // GET /admin/notifications/status (§6) for operators and admin UIs.
    if (isProduction) {
      logger.error(`${message} This is unexpected in production.`);
    } else {
      logger.warn(message);
    }
    return null;
  }

  try {
    const raw = serviceAccountPath
      ? readFileSync(serviceAccountPath, 'utf8')
      : (serviceAccountJson as string);
    const serviceAccount = JSON.parse(raw) as ServiceAccount;
    return initializeApp({
      credential: cert(serviceAccount),
      projectId,
    });
  } catch (error) {
    logger.error(
      `Failed to initialize Firebase Admin SDK — FCM sending disabled: ${(error as Error).message}`,
    );
    return null;
  }
}

export const firebaseAdminProvider: FactoryProvider<App | null> = {
  provide: FIREBASE_ADMIN_APP,
  inject: [ConfigService],
  useFactory: createFirebaseAdminApp,
};
