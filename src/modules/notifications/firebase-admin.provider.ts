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

  if (!serviceAccountPath && !serviceAccountJson) {
    logger.warn('No Firebase credentials configured — FCM sending is disabled (safe no-op mode).');
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
