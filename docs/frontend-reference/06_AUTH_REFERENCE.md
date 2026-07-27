# 06 — Auth Reference

Source: `src/modules/auth/*`, `src/common/guards/*`, `src/common/decorators/*`.

## The account model

There is **one** `User` table for everyone — customers, guests, and admins. Two columns distinguish them:

- `role`: `CUSTOMER` | `ADMIN`
- `isGuest`: `boolean`

A guest is a `role: CUSTOMER, isGuest: true` row with no email/password — **not** a special anonymous/tokenless
mode. Every guest session has a real, fully-functional access+refresh token pair issued by `POST /auth/guest`.

There is no separate "admin" table, no separate admin database, and no separate admin API host — admins are
just `User` rows with `role: ADMIN`, authenticating against the exact same JWT infrastructure.

## Customer login

```
POST /api/v1/auth/login
Content-Type: application/json

{ "email": "customer@example.com", "password": "..." }
```
→ `200 { user, accessToken, refreshToken }`

This endpoint does **not** check role — it will happily log in an ADMIN account too and return a working admin
token pair. It is functionally "login for any account," and is the endpoint the app should call for its
regular sign-in screen.

## Admin login

```
POST /api/v1/admin/auth/login          ← canonical
POST /api/v1/auth/admin/login          ← alias, identical handler
Content-Type: application/json

{ "email": "admin@example.com", "password": "..." }
```
→ `200 { user, accessToken, refreshToken }` — **only** if `user.role === "ADMIN"`; otherwise `403 NOT_ADMIN` even
with fully correct credentials.

**Practical guidance**: the customer app should call `/auth/login`. The admin panel should call
`/admin/auth/login` (it gets the extra role check "for free" and a dedicated brute-force bucket — see below).
Either admin path works identically; pick one and stay consistent, they will never diverge.

## Guest session

```
POST /api/v1/auth/guest
Content-Type: application/json

{ "deviceId": "optional-string" }   ← accepted but currently unused server-side
```
→ `201 { user, accessToken, refreshToken }`, `user.isGuest === true`, `user.email === null`.

A guest access token authenticates identically to a real customer's for every endpoint that doesn't explicitly
check `isGuest` (loyalty is the one feature that explicitly rejects guests — `403 GUEST_NOT_ELIGIBLE`).

## Tokens

### Access token
- A real **JWT**, HS256-signed with `JWT_ACCESS_SECRET` (server-side secret, never exposed).
- Lifetime: `JWT_ACCESS_TTL` env var, default `15m`.
- Payload: `{ sub: userId, role: "CUSTOMER"|"ADMIN", isGuest: boolean, jti: uuid, iat, exp }`.
- Send it as `Authorization: Bearer <accessToken>` on every non-public request.
- **Do not** decode this token client-side to make authorization decisions beyond simple UI state (e.g. "show admin menu") — the server always re-verifies signature + expiry + role on every request; a client-side decode is purely cosmetic.

### Refresh token
- **Not a JWT.** An opaque random string (48 random bytes, base64url-encoded).
- Server stores only its **SHA-256 hash** (`RefreshToken.tokenHash`) — the raw value is never persisted, only returned once at issuance/rotation.
- Lifetime: `JWT_REFRESH_TTL_DAYS` env var, default `30` days.
- **Rotates on every use.** Calling `POST /auth/refresh` invalidates the presented token and issues a brand-new one — the frontend must always store and use the *latest* refresh token returned, never reuse an old one.
- **Reuse detection**: if a refresh token that was already rotated once is presented again (e.g. stolen and used by an attacker after the legitimate client already rotated it), the server treats this as compromise and revokes **every** token in that session's lineage (`familyId`) — forcing a full re-login on every device tied to that lineage. If `/auth/refresh` ever returns `401 REFRESH_TOKEN_REUSED`, the frontend must clear all stored credentials and route to the login screen — retrying will not help.

### Refreshing
```
POST /api/v1/auth/refresh
Content-Type: application/json

{ "refreshToken": "<stored refresh token>" }
```
→ `200 { accessToken, refreshToken }` (new pair; store both, discard the old refresh token immediately).

Errors: `401 INVALID_REFRESH_TOKEN` (garbage/unknown token), `401 REFRESH_TOKEN_EXPIRED`, `401 REFRESH_TOKEN_REUSED` (see above). All three should route to a full logout/login flow client-side — there's no partial-recovery path.

### Logout
- `POST /auth/logout` with `{ "refreshToken": "..." }` in the body → revokes that one session (204). If the body is empty, no refresh token is revoked (the access token itself isn't "revoked" — it just naturally expires within `JWT_ACCESS_TTL`).
- `POST /auth/logout-all` (no body) → revokes **every** active refresh token for the user, across all devices (204). Use this for "log out everywhere."

## Roles & authorization model

Enforced by two chained global guards, applied to **every** route unless overridden:

1. **`JwtAccessGuard`** — verifies the Bearer token. Skipped entirely on routes decorated `@Public()`.
2. **`RolesGuard`** — checks `@Roles(...)` metadata against `request.user.role`. Behavior:
   - **No `@Roles()` decorator on the route** → any authenticated principal passes (customer, guest, or admin). This is the default for most customer-facing endpoints (cart, orders, addresses, devices).
   - **`@Roles('ADMIN')`** → only `role === 'ADMIN'` passes; anyone else gets `403 FORBIDDEN` (code `FORBIDDEN`, not a role-specific code).
   - **`@Roles('CUSTOMER')`** → only `role === 'CUSTOMER'` passes — **this includes guests**, since guests are `role: CUSTOMER, isGuest: true`. An ADMIN account gets `403` on these routes (e.g. checkout, favorites, loyalty are all `@Roles('CUSTOMER')`-gated, meaning an admin account literally cannot place an order or favorite an item through the API as written).
   - **`@Public()`** → bypasses both guards entirely — no token required at all, and if one is sent it's ignored (not validated).

### Which endpoints require which role (quick reference — full detail in `02_API_REFERENCE.md`)

| Auth requirement | Endpoints |
|---|---|
| Public | catalog browsing, `/settings` (GET), `/health*`, `/auth/register`, `/auth/login`, `/auth/admin/login`, `/admin/auth/login`, `/auth/refresh`, `/auth/guest`, `/payments/webhook` |
| Any authenticated (incl. guests) | `/users/me*`, `/cart/*`, `/orders` list/detail/status (GET), `/devices/*`, `/me/addresses/*`, `/promos/validate`, `/payments/:id` (GET) |
| CUSTOMER only (guests included, ADMIN excluded) | `POST /checkout` / `POST /orders`, `POST /payments/intent`, `/me/favorites/*`, `/me/loyalty*` (loyalty additionally excludes guests via an in-handler check) |
| ADMIN only | everything under `/admin/*`: categories, menu, orders, promos, settings, notifications, uploads |

### Guests specifically

Guests pass every "any authenticated" and "CUSTOMER" check — they are a full role, not a degraded mode. The
**only** place guests are explicitly excluded is `/me/loyalty*`, via an explicit `assertNotGuest(user.isGuest)`
check in the controller (separate from and stricter than the `@Roles('CUSTOMER')` decorator alone).

## Brute-force lockout

An in-memory (single-instance, no Redis) tracker guards login endpoints, keyed by `scope:ip:email`:

- Scopes are **separate buckets**: `login` (customer) vs `admin-login` (admin) — failing 5 times against
  `/auth/login` for a given email/IP does not lock out `/admin/auth/login` for the same email/IP, and vice versa.
- After `BRUTE_FORCE_MAX_ATTEMPTS` (default `5`) failed attempts within the tracking window, further attempts
  for that exact `scope:ip:email` key are rejected with `423 ACCOUNT_LOCKED` for `BRUTE_FORCE_LOCK_MINUTES`
  (default `15`) — **even if the correct password is subsequently provided**, until the lockout window expires.
- A successful login clears the counter for that key immediately.
- This state is **in-memory and per-process** — restarting the API process (e.g. a deploy) clears all lockouts.

## Throttling (separate from brute-force, applies regardless of credentials)

- Global default: 100 requests / 60s per IP (`THROTTLE_LIMIT` / `THROTTLE_TTL_SECONDS`).
- Auth endpoints (`register`, `signup`, `login`, both admin-login paths): 20 req/60s.
- A few other "sensitive" routes (`promos/validate`, `payments/webhook`) also use the 20/60s bucket.
- Hitting a throttle limit returns a standard `429` via `ThrottlerGuard` (not the brute-force `423`).

## What the frontend must implement

1. Store `accessToken` + `refreshToken` securely (secure storage, not plain SharedPreferences/localStorage).
2. Attach `Authorization: Bearer <accessToken>` to every request except the explicitly-public ones listed above.
3. On `401` with a token attached, attempt one silent `POST /auth/refresh`; on success, retry the original request once with the new access token. On refresh failure (any of the three 401 codes above), clear stored tokens and route to login.
4. After `POST /auth/refresh` succeeds, **overwrite both stored tokens** — the refresh token changes every time, not just the access token.
5. Never assume a stored access token is still valid without a server round-trip — client-side JWT expiry checks are an optimization, not a substitute for handling a `401` from the server.
