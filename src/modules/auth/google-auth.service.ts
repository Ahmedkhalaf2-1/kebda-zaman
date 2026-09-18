import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { App } from 'firebase-admin/app';
import { FIREBASE_ADMIN_APP } from '../notifications/firebase-admin.provider';

export interface VerifiedFirebaseIdentity {
  uid: string;
  /** Always present and lower-cased — verification rejects a token without one. */
  email: string;
  name?: string;
  picture?: string;
  signInProvider?: string;
}

// Kept as an alias so the existing Google-specific tests and imports remain
// source-compatible while Apple Sign-In uses the same verified identity shape.
export type VerifiedGoogleIdentity = VerifiedFirebaseIdentity;

const INVALID_TOKEN_RESPONSE = {
  message: 'Invalid Google authentication token',
  code: 'INVALID_GOOGLE_TOKEN',
};

const INVALID_APPLE_TOKEN_RESPONSE = {
  message: 'Invalid Apple authentication token',
  code: 'INVALID_APPLE_TOKEN',
};

const FIREBASE_DELETE_FAILED_RESPONSE = {
  message: 'Failed to delete the linked Firebase account. Please try again.',
  code: 'FIREBASE_DELETE_FAILED',
};

/**
 * Verifies a Firebase ID token minted by the Flutter app after Google Sign-In,
 * using the SAME Firebase Admin app the notifications module already
 * initializes (plan: no duplicate app, no second credential). Every identity
 * value returned comes from the signature-verified token — never from the
 * raw, unverified JWT payload.
 */
@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);

  constructor(@Inject(FIREBASE_ADMIN_APP) private readonly firebaseApp: App | null) {}

  async verify(firebaseIdToken: string): Promise<VerifiedGoogleIdentity> {
    return this.verifyProvider(firebaseIdToken, 'google.com', INVALID_TOKEN_RESPONSE, 'Google');
  }

  async verifyApple(firebaseIdToken: string): Promise<VerifiedFirebaseIdentity> {
    return this.verifyProvider(firebaseIdToken, 'apple.com', INVALID_APPLE_TOKEN_RESPONSE, 'Apple');
  }

  private async verifyProvider(
    firebaseIdToken: string,
    expectedProvider: 'google.com' | 'apple.com',
    invalidResponse: { message: string; code: string },
    providerLabel: 'Google' | 'Apple',
  ): Promise<VerifiedFirebaseIdentity> {
    if (!this.firebaseApp) {
      this.logger.error(
        `${providerLabel} sign-in attempted but Firebase Admin is not configured — rejecting.`,
      );
      throw new UnauthorizedException(invalidResponse);
    }

    let decoded;
    try {
      // Imported lazily (only once a Google login is actually attempted)
      // rather than at module load — 'firebase-admin/auth' pulls in a JWKS
      // client this codebase otherwise never touches (FCM only needs
      // 'firebase-admin/app' and 'firebase-admin/messaging').
      const { getAuth } = await import('firebase-admin/auth');
      // verifyIdToken checks signature, expiry, issuer and audience against
      // this Admin app's own Firebase project (keebda-zaman) — a token
      // minted for a different project is rejected here.
      decoded = await getAuth(this.firebaseApp).verifyIdToken(firebaseIdToken);
    } catch (error) {
      // Never log the token itself — only the SDK's own error message.
      this.logger.warn(
        `${providerLabel} ID token verification failed: ${(error as Error).message}`,
      );
      throw new UnauthorizedException(invalidResponse);
    }

    const email = decoded.email?.trim().toLowerCase();
    if (!email) {
      throw new UnauthorizedException(invalidResponse);
    }
    if (decoded.email_verified !== true) {
      throw new UnauthorizedException(invalidResponse);
    }
    // This endpoint is Google Sign-In only — a valid Firebase ID token minted
    // via password auth, anonymous auth, or any other provider must not be
    // accepted here even though it passes signature verification above.
    const signInProvider = decoded.firebase?.sign_in_provider;
    if (signInProvider !== expectedProvider) {
      throw new UnauthorizedException(invalidResponse);
    }

    return {
      uid: decoded.uid,
      email,
      name: typeof decoded.name === 'string' ? decoded.name : undefined,
      picture: typeof decoded.picture === 'string' ? decoded.picture : undefined,
      signInProvider,
    };
  }

  /**
   * Deletes the Firebase Auth user backing a linked account (account
   * deletion flow, called BEFORE the local DB cleanup — see
   * AuthService.deleteAccount for why that order is the safe one).
   * Firebase's own "already gone" response is treated as success (deleting
   * is naturally idempotent), so a retried deletion request never fails on
   * this step. Any other failure is surfaced explicitly, never swallowed —
   * silently reporting success while a live Firebase identity (email, name,
   * photo) survives would defeat the point of deleting the account.
   */
  async deleteUser(uid: string): Promise<void> {
    if (!this.firebaseApp) {
      this.logger.error(
        'Account deletion requires removing a linked Firebase user, but Firebase Admin is not configured.',
      );
      throw new ServiceUnavailableException(FIREBASE_DELETE_FAILED_RESPONSE);
    }

    try {
      // Lazily imported for the same reason as verify() above.
      const { getAuth } = await import('firebase-admin/auth');
      await getAuth(this.firebaseApp).deleteUser(uid);
    } catch (error) {
      if (this.isUserNotFound(error)) {
        return;
      }
      // Never log the uid alongside anything token-like — only the SDK's
      // own error message, same convention as verify() above.
      this.logger.error(`Firebase user deletion failed: ${(error as Error).message}`);
      throw new ServiceUnavailableException(FIREBASE_DELETE_FAILED_RESPONSE);
    }
  }

  private isUserNotFound(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: unknown }).code === 'auth/user-not-found'
    );
  }
}
