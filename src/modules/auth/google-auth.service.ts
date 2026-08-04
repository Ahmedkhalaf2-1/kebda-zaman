import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { App } from 'firebase-admin/app';
import { FIREBASE_ADMIN_APP } from '../notifications/firebase-admin.provider';

export interface VerifiedGoogleIdentity {
  uid: string;
  /** Always present and lower-cased — verification rejects a token without one. */
  email: string;
  name?: string;
  picture?: string;
  signInProvider?: string;
}

const INVALID_TOKEN_RESPONSE = {
  message: 'Invalid Google authentication token',
  code: 'INVALID_GOOGLE_TOKEN',
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
    if (!this.firebaseApp) {
      this.logger.error(
        'Google sign-in attempted but Firebase Admin is not configured — rejecting.',
      );
      throw new UnauthorizedException(INVALID_TOKEN_RESPONSE);
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
      this.logger.warn(`Google ID token verification failed: ${(error as Error).message}`);
      throw new UnauthorizedException(INVALID_TOKEN_RESPONSE);
    }

    const email = decoded.email?.trim().toLowerCase();
    if (!email) {
      throw new UnauthorizedException(INVALID_TOKEN_RESPONSE);
    }
    if (decoded.email_verified !== true) {
      throw new UnauthorizedException(INVALID_TOKEN_RESPONSE);
    }
    // This endpoint is Google Sign-In only — a valid Firebase ID token minted
    // via password auth, anonymous auth, or any other provider must not be
    // accepted here even though it passes signature verification above.
    const signInProvider = decoded.firebase?.sign_in_provider;
    if (signInProvider !== 'google.com') {
      throw new UnauthorizedException(INVALID_TOKEN_RESPONSE);
    }

    return {
      uid: decoded.uid,
      email,
      name: typeof decoded.name === 'string' ? decoded.name : undefined,
      picture: typeof decoded.picture === 'string' ? decoded.picture : undefined,
      signInProvider,
    };
  }
}
