# Password Reset — API Contract

Email-based self-service password recovery for local (email/password) accounts on this backend. Covers `POST /api/v1/auth/forgot-password` and `POST /api/v1/auth/reset-password`.

## Credential authority

Password credentials belong to **this backend** (`User.passwordHash`, argon2id). Google/Apple sign-in accounts authenticate through Firebase and typically have `passwordHash = null` — this feature never creates a local password for such an account. If the submitted email belongs to a Google/Apple-only account, `forgot-password` silently does nothing for it (same generic response as any other ineligible case — see below).

## Endpoints

### `POST /api/v1/auth/forgot-password`

Public, rate-limited (`AUTH_THROTTLE`: 20 requests/IP/60s — the same class as `/auth/login`/`/auth/register`), plus a stricter **per-email** cooldown/cap enforced server-side (see [Throttling](#throttling)).

**Request**

```json
{ "email": "customer@example.com" }
```

| Field | Type | Rules |
|---|---|---|
| `email` | string | `@IsEmail`, max 255 chars |

**Response — always `200 OK`, always this exact shape, regardless of whether the email matches an account:**

```json
{ "message": "If an account exists for this email, a password reset link has been sent." }
```

This response is identical for:
- an email with no matching account,
- a matching account that is deleted (`deletedAt` set),
- a matching account with no local password (Google/Apple-only sign-in),
- a matching, eligible account (where a real token is created and an email is actually attempted),
- a matching, eligible account where the email provider (Resend) failed or timed out.

**No response field, header, or timing signal distinguishes any of the above from each other** — this is deliberate (no account enumeration).

**Error responses (do not depend on the submitted email — see [Throttling](#throttling)):**

| Status | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed/missing `email` |
| 429 | `PASSWORD_RESET_COOLDOWN` | Another request for this exact email arrived within the last 60s |
| 429 | `PASSWORD_RESET_RATE_LIMITED` | More than 3 requests for this email within a 15-minute window |
| 429 | (ThrottlerException, generic) | Per-IP route throttle exceeded (20/60s) |

---

### `POST /api/v1/auth/reset-password`

Public, rate-limited (`AUTH_THROTTLE`: 20 requests/IP/60s).

**Request**

```json
{ "token": "<raw token from the reset link>", "password": "newPassword123" }
```

| Field | Type | Rules |
|---|---|---|
| `token` | string | 1–512 chars |
| `password` | string | 8–72 chars (identical policy to `/auth/register`) |

**Success — `200 OK`:**

```json
{ "message": "Your password has been reset. Please log in again with your new password." }
```

No `accessToken`/`refreshToken` is returned — this endpoint **never logs the user in**. The client must send them to the normal login screen afterward.

**Error responses:**

| Status | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Malformed/missing `token`, or `password` fails the length policy |
| 401 | `INVALID_RESET_TOKEN` | Token was never issued, or the account is no longer eligible (deleted, or lost its local password) since the token was issued — same code either way, so this never reveals *why* |
| 401 | `RESET_TOKEN_ALREADY_USED` | Token was already consumed by an earlier successful reset (or superseded — see below) |
| 401 | `RESET_TOKEN_EXPIRED` | Token's 15-minute window has passed |
| 429 | (ThrottlerException, generic) | Per-IP route throttle exceeded |

**What a successful reset actually does, atomically (one DB transaction):**
1. Atomically claims the token (`usedAt: null` in the WHERE clause of the claiming `UPDATE`) — this is what guarantees that two concurrent submissions of the same token can produce at most one success; the loser always gets `RESET_TOKEN_ALREADY_USED`.
2. Hashes and sets the new password (argon2id, same as registration).
3. Invalidates every *other* still-live reset token for that user (e.g. from an earlier `forgot-password` call within its own 15-minute window).
4. Revokes every active refresh-token session for that user (all devices) — see [Session invalidation](#session-invalidation-and-a-known-limitation).
5. Never re-nulls `deletedAt`, never touches `role`. A disabled/deleted account cannot be reactivated through this flow.

---

## Reset-link format (frontend contract)

The email contains a single link:

```
{PASSWORD_RESET_URL}?token={raw_token}
```

- `PASSWORD_RESET_URL` is a **server-configured, trusted base URL** (env var) — never derived from the request's `Host` header, never a client-supplied redirect.
- `{raw_token}` is the opaque, URL-safe (`base64url`) token — pass it verbatim as the `token` field of the `reset-password` request body.
- The link is valid for **15 minutes** and is **single-use**.

### ⚠️ No frontend reset page exists yet

**As of this writing, `PASSWORD_RESET_URL` is intentionally left unset** (see `.env.example`) because no page exists to receive the link. Until one is built, `forgot-password` still works and responds correctly — it just can't actually deliver a usable email (see [Configuration](#configuration): `EmailService`/`AuthService` treat an unset `PASSWORD_RESET_URL` as "can't send yet," logging a warning and skipping the send, while the API response stays the same generic 200).

**What the frontend still needs to build**, before this feature is usable end-to-end:
1. A web (or deep-link) page at whatever URL `PASSWORD_RESET_URL` is set to, which:
   - Reads the `token` query parameter.
   - Presents a "new password" form.
   - Calls `POST /api/v1/auth/reset-password` with `{ token, password }`.
   - On success, redirects to login (never auto-logs-in — the API doesn't return tokens).
   - On `RESET_TOKEN_EXPIRED`/`RESET_TOKEN_ALREADY_USED`/`INVALID_RESET_TOKEN`, shows a clear "this link is no longer valid, request a new one" message and a way back to the forgot-password screen.
2. A "Forgot password?" entry point on the login screen that calls `POST /api/v1/auth/forgot-password` and shows the generic success message (or the 429 cooldown/rate-limit messages) — never a "no account found" message, since the backend deliberately never says that.
3. Once that page's real URL is decided, set `PASSWORD_RESET_URL` accordingly (see below) and the flow is live.

---

## Throttling

Two independent layers, both required by design:

1. **Per-IP** (`AUTH_THROTTLE`, `src/modules/auth/auth-throttle.const.ts`): 20 requests/60s, same class NestJS `ThrottlerGuard` already applies to `/auth/login`, `/auth/register`, etc. Applies to both endpoints.
2. **Per-email** (`PasswordResetThrottleService`, in-memory, single-instance — same convention as `BruteForceService`, no Redis yet): applies only to `forgot-password`, keyed by the *normalized* (trimmed, lowercased) submitted email string — **identical whether or not that email has an account**, so it never leaks account existence:
   - **Resend cooldown**: at most 1 request per email per 60 seconds.
   - **Abuse cap**: at most 3 requests per email per 15-minute window.
   - The check-and-record is synchronous with no `await` in between, closing the race for two genuinely concurrent requests for the same email (only one can ever pass).

`assertNotLocked`-style login lockout (`BruteForceService`, `423 ACCOUNT_LOCKED`) is untouched by this feature — a password-reset request never counts against or clears login lockout state, and vice versa.

---

## Session invalidation and a known limitation

A successful reset **immediately revokes every refresh-token session** (`RefreshToken.revokedAt`) for the account — no device can silently keep refreshing after a reset, on any device.

**Outstanding *access* tokens are not force-revoked** and remain valid until they naturally expire (`JWT_ACCESS_TTL`, 15 minutes by default). This is a deliberate, existing architectural tradeoff in this codebase, not something introduced by this feature: `JwtAccessGuard` verifies only the JWT signature and never re-reads the user row on every request — see `ActiveDriverGuard`'s own doc comment, which documents that this exact tradeoff (immediate revocation vs. a DB round-trip on every authenticated request, for every role) was already considered once, for account deactivation, and deliberately rejected at the time for cost/scope reasons; a DB check was added only for the one role (`DRIVER`) that needed immediate effect, not globally.

This feature reuses that same posture rather than silently reversing it: if a stolen access token exists at the moment of a password reset, it keeps working for up to 15 minutes afterward (it just can never be refreshed again). If your threat model requires *immediate* access-token invalidation on reset, the fix is a global `tokenVersion`-style check in `JwtAccessGuard` (compare a claim baked into the JWT against a counter on `User`, bumped on reset) — this was deliberately **not** implemented here, since it's a cross-cutting change affecting the latency of every authenticated request in the app, not a password-reset-specific change, and reverses a precedent the codebase already set once. Flag this explicitly if you want it built as a separate, reviewed change.

---

## Configuration

Add to your environment (see `.env.example` for the full block with inline comments):

| Var | Required | Notes |
|---|---|---|
| `RESEND_API_KEY` | For sending to actually work | Sending-only key from resend.com. **Configure it directly on the server** (the VPS's `.env`, or your process manager's secret store) — never paste it into a chat, ticket, or PR. Left unset, `forgot-password` still responds correctly, it just can't deliver the email (logged as a warning in non-production, an error in production). |
| `EMAIL_FROM` | For sending to actually work | e.g. `Kebda Zaman <noreply@mail.kebdazaman.cloud>` — must match a domain verified in your Resend account (`mail.kebdazaman.cloud` is already verified per the task setup). |
| `PASSWORD_RESET_URL` | For sending to actually work | Trusted base URL of the frontend reset page — see [above](#-no-frontend-reset-page-exists-yet). Left unset, the token/row is still created but no email is attempted. |

`RESEND_API_KEY` is included in the production placeholder guard (`src/config/validation.schema.ts`'s `SECRET_ENV_KEYS`) — the app refuses to boot in production if it's still a literal `CHANGE_ME`-style placeholder.

---

## Safe local verification

1. Bring up the local stack per the existing README/docker-compose (Postgres on `localhost:5433`, matching `DATABASE_URL` in your local `.env`) — **never point this at the production VPS DB**.
2. The `PasswordResetToken` table migration (`prisma/migrations/20260918231345_add_password_reset_tokens`) is purely additive (one new table + FK) — already applied to the local dev DB during this work; run `npm run prisma:migrate` on any other local/staging DB to pick it up.
3. Leave `RESEND_API_KEY`/`PASSWORD_RESET_URL` unset locally unless you specifically want to test real delivery — `forgot-password` and the whole flow still work end-to-end (the token is created; you can read it straight out of the `PasswordResetToken` table, or intercept it via a mocked `EmailService` in a test, to call `reset-password` manually).
4. Automated coverage:
   - `npm run test:password-reset` — full integration suite against the real local DB (round trip, generic-response/no-enumeration, invalid/expired/reused/concurrent tokens, session revocation across devices, provider-failure handling, rate limit + resend cooldown). `EmailService` is DI-overridden with a `jest.fn()` mock in every test — **no real email is ever sent by this suite.**
   - Unit suites: `npx jest src/modules/auth src/modules/email` (throttle service, `AuthService.forgotPassword`/`resetPassword` logic, `EmailService` Resend HTTP client, bilingual email template).

## Deployment

1. On the VPS, add `RESEND_API_KEY`, `EMAIL_FROM`, and `PASSWORD_RESET_URL` to the server's own `.env` (never commit real values; never paste the key into a ticket/chat).
2. Apply the migration with `prisma migrate deploy` (never `migrate dev`/`db push` against production) — per this project's standing production-data-safety rules, take a `pg_dump` backup first and get explicit sign-off before running any migration against the real database.
3. Confirm `PASSWORD_RESET_URL` points at a real, deployed frontend page (see the limitation above) before relying on this in production — until then, the email will contain a dead link.

## What's NOT covered / remaining limitations

- **No frontend reset page** — see above. This is the main blocker to the feature being end-to-end usable.
- **No immediate access-token revocation** — see [Session invalidation](#session-invalidation-and-a-known-limitation).
- **Federated (Google/Apple) accounts cannot recover a password through this flow**, by design — they don't have one. If a user wants a local password added to a federated account, that's a distinct, not-yet-built feature (and would need its own explicit design decision, per the task's instruction not to silently do this).
- **In-memory throttling is single-instance** — if this API is ever horizontally scaled across multiple processes/containers without a shared store (Redis, etc.), the per-email cooldown/cap and the per-IP route throttle each become "per-instance" rather than global. Same existing limitation as `BruteForceService`'s login lockout — not new to this feature.
