import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

// Flutter Web's dev server binds to a random localhost port per run, so a
// fixed allowlist entry can't cover it — match the whole loopback range
// instead. Only ever reflected back for requests that actually originate
// from a browser on the developer's own machine (Origin can't be spoofed).
const LOCAL_DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Shared between main.ts (bootstrap) and e2e tests so both exercise the
 * exact same CORS decision logic.
 */
export function buildCorsOptions(allowedOrigins: string[]): CorsOptions {
  return {
    // A function (rather than the static array) is required so the `cors`
    // package always runs its OPTIONS-handling branch — passing `origin:
    // false` (the previous behavior when the allowlist was empty) makes it
    // skip that branch entirely and fall through to the router, which has no
    // OPTIONS handler and 404s the preflight before the browser ever sends
    // the real request.
    origin: (requestOrigin, callback) => {
      // Non-browser clients (native/mobile, curl, server-to-server) send no
      // Origin header — nothing to check, and no browser will enforce CORS
      // on the response anyway.
      if (!requestOrigin) {
        callback(null, true);
        return;
      }
      const isAllowed =
        LOCAL_DEV_ORIGIN.test(requestOrigin) || allowedOrigins.includes(requestOrigin);
      callback(null, isAllowed);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };
}
