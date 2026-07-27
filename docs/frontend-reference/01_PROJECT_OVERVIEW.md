# 01 — Project Overview

> Generated directly from the backend source code at `kebda-zaman-backend` (NestJS 11 + Prisma 6 + PostgreSQL 16).
> This document set is the single source of truth for the Flutter frontend team. If something here conflicts with
> an older doc (e.g. `BACKEND_IMPLEMENTATION_PLAN.md`, `API_INTEGRATION_GUIDE.md`), **this reflects the current
> implementation and wins.**

## What this backend is

"Kebda Zaman" is a food-ordering backend for a single restaurant (not a multi-vendor marketplace). It serves:

- A **customer-facing Flutter app** (browse menu, cart, checkout, track orders, addresses, favorites, loyalty).
- An **admin panel** (catalog/category/promo/settings management, order management, push-notification campaigns).

Both apps talk to the **same NestJS process** and the **same base URL** — there is no separate admin backend.

## Base URL and versioning

- Global prefix: `api`
- URI versioning, default version `1`
- **Every endpoint in this document set is reachable at `/api/v1/...`** (e.g. `POST /api/v1/auth/login`).
- Uploaded images are served from a **separate, unversioned static route**: `/uploads/<filename>` (see `07_UPLOAD_SYSTEM.md`). This is intentional — static assets are not an API version-bound resource.
- The server binds `0.0.0.0` and listens on `API_PORT` (default `3000`).

## Architecture

```
Flutter Customer App ─┐
                       ├─► NestJS API (/api/v1) ─► PostgreSQL (Prisma)
Flutter Admin App    ─┘         │
                                 ├─► Firebase Admin SDK ─► FCM ─► Device tokens
                                 └─► Local disk storage ─► /uploads static route
```

Request pipeline (global, applied to every route in this order):
1. **Helmet** security headers (`crossOriginResourcePolicy: cross-origin` — deliberately relaxed so `<img>` tags on a different origin, e.g. a web admin panel, can load `/uploads/...` images).
2. **CORS** — explicit origin allowlist from `CORS_ORIGINS` env var (comma-separated). No wildcard. If empty, CORS is disabled entirely (`origin: false`).
3. **ThrottlerGuard** — global rate limit (`THROTTLE_LIMIT` requests per `THROTTLE_TTL_SECONDS`, default 100/60s). Stricter per-route throttles exist on sensitive endpoints (see `06_AUTH_REFERENCE.md` and `02_API_REFERENCE.md`).
4. **JwtAccessGuard** — verifies `Authorization: Bearer <accessToken>` and attaches `request.user = { id, role, isGuest, jti }`. Routes marked `@Public()` skip this.
5. **RolesGuard** — enforces `@Roles('ADMIN')` / `@Roles('CUSTOMER')` metadata against `request.user.role`. Routes with no `@Roles()` decorator allow **any authenticated principal** (including guests). `@Public()` routes skip this too.
6. **ValidationPipe** (global) — `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`. Any request body field not declared in the DTO is **rejected** (400), not silently dropped. Query params are auto-coerced (e.g. `?page=2` → `number`).
7. **AllExceptionsFilter** (global) — every error response uses one canonical JSON envelope (see `02_API_REFERENCE.md` → "Error envelope").

## Modules (1:1 with `src/modules/*`)

| Module | Responsibility |
|---|---|
| `auth` | Register/login (customer + admin), guest sessions, refresh-token rotation, logout, brute-force lockout |
| `users` | Own profile read/update (`/users/me`) |
| `catalog` | Public menu/categories browsing + search; admin CRUD for categories and menu items (incl. variants/addon groups/addons) |
| `pricing` | **Not exposed via HTTP.** Internal service every price in the system flows through — the client never sends a price |
| `settings` | Restaurant settings singleton (delivery fee, tax rate, min order, working hours, maintenance mode) — public read, admin write |
| `cart` | Server-persisted per-user cart, promo application |
| `promos` | Customer promo validation against the caller's real cart; admin promo CRUD |
| `orders` | Checkout (cart → order), customer order history/tracking, admin order list/detail/status transitions |
| `payments` | Gateway-agnostic payment intents + webhook processing; only Cash-on-Delivery is a real, working provider today |
| `notifications` | Firebase Admin SDK wiring, FCM sending, admin push-notification campaigns (immediate + scheduled) |
| `devices` | FCM device-token registration/refresh/removal |
| `addresses` | Saved delivery addresses (`/me/addresses`), single-default enforcement |
| `favorites` | Favorite menu items (`/me/favorites`) |
| `loyalty` | Points balance/ledger, redemption catalog, auto-earn on delivered orders |
| `uploads` | Single generic admin image-upload endpoint used by menu items today (see `07_UPLOAD_SYSTEM.md`) |
| `health` | Liveness/readiness probes (`/health`, `/health/ready`) |

## Authentication (see `06_AUTH_REFERENCE.md` for full detail)

- **One shared credential model.** `User` has `role: CUSTOMER | ADMIN` and `isGuest: boolean`. There is no separate "Admin" table.
- **Two login endpoints exist, both call the same underlying logic**, with one difference: admin login additionally requires `role === ADMIN`, and non-admins get `403 NOT_ADMIN`.
  - `POST /api/v1/auth/login` — customer/any-role login.
  - `POST /api/v1/admin/auth/login` (canonical) and `POST /api/v1/auth/admin/login` (alias, same handler) — admin login.
- Access token: short-lived JWT (`JWT_ACCESS_TTL`, default `15m`), HS256, payload `{ sub, role, isGuest, jti }`.
- Refresh token: opaque random string, **not a JWT**. Only its SHA-256 hash is stored server-side. Rotated on every use; reuse of an already-rotated token revokes the entire session family (forces re-login on all devices in that lineage).
- Guests: `POST /api/v1/auth/guest` creates a real `User` row with `isGuest: true`, `role: CUSTOMER`, and returns a real token pair — guests are fully authenticated principals, not anonymous.

## Upload system (see `07_UPLOAD_SYSTEM.md`)

One generic endpoint, `POST /api/v1/admin/uploads/image` (ADMIN only, `multipart/form-data`, field name `file`), stores the file on disk (or a mounted volume) and returns `{ "imageUrl": "<public URL>" }`. The frontend then passes that URL as a plain string into whichever entity's `imageUrl` field (currently only `MenuItem.imageUrl` is wired to accept it; see the "Known gaps" note in `10_FRONTEND_CHECKLIST.md`).

## Notifications (see `08_NOTIFICATION_REFERENCE.md`)

- FCM device tokens are registered per-device via `/api/v1/devices/*` (any authenticated principal, including guests).
- Admin push campaigns (`/api/v1/admin/notifications/*`) target `ALL | CUSTOMERS | GUESTS`, can be sent immediately or scheduled (polled every 60s by an in-process scheduler — no Redis/queue).
- Order-status changes automatically fire a best-effort FCM push to the order's owner (failure is logged, never blocks the status-change response).
- If no Firebase credentials are configured (`FIREBASE_SERVICE_ACCOUNT_PATH` / `FIREBASE_SERVICE_ACCOUNT_JSON`), sending is a **safe no-op** — the app still boots and all endpoints still respond normally, they just don't deliver pushes.

## Order lifecycle (see `05_ORDER_LIFECYCLE.md` for the full state machine)

```
Customer browses catalog (public, no auth)
        │
        ▼
Cart (server-persisted, one per user, created lazily)
        │  add/update/remove items, apply/remove promo
        ▼
Checkout — POST /api/v1/checkout (= POST /api/v1/orders, same handler)
        │  server re-prices everything from scratch; cart cleared only on success
        ▼
Order created — status PENDING, Payment row created PENDING
        │
        ▼
Admin updates status — PATCH /api/v1/admin/orders/:id/status
        │  PENDING → CONFIRMED → PREPARING → OUT_FOR_DELIVERY → DELIVERED
        │  (CANCELLED reachable from PENDING/CONFIRMED/PREPARING/OUT_FOR_DELIVERY)
        │  on DELIVERED: Cash payments auto-settle to PAID, loyalty points are earned
        ▼
Customer tracking — GET /api/v1/orders/:id/status (status + full history + ETA)
        push notification fired to the customer's devices on every transition
```

## Customer flow (screens → endpoints, high level)

1. Home / catalog browse → `GET /categories`, `GET /menu`, `GET /home/featured`, `GET /menu/search`
2. Item detail → `GET /menu/items/:id`
3. Cart → `GET/POST/PUT/DELETE /cart*`
4. Promo → `POST /cart/apply-promo`, `POST /promos/validate`
5. Checkout → `POST /checkout`
6. Order tracking → `GET /orders`, `GET /orders/:id`, `GET /orders/:id/status`
7. Payment (non-cash, currently unavailable) → `POST /payments/intent`, `GET /payments/:id`
8. Profile → `GET/PATCH /users/me`
9. Addresses → `/me/addresses/*`
10. Favorites → `/me/favorites/*`
11. Loyalty → `/me/loyalty*`
12. Device/push registration → `/devices/*`

## Admin flow (screens → endpoints, high level)

1. Admin login → `POST /admin/auth/login`
2. Dashboard/orders → `GET /admin/orders`, `GET /admin/orders/:id`, `PATCH /admin/orders/:id/status`
3. Categories → `/admin/categories*`
4. Menu items (incl. variants/addons) → `/admin/menu*`
5. Image upload (used from the menu item form) → `POST /admin/uploads/image`
6. Promos → `/admin/promos*`
7. Restaurant settings → `/admin/settings`
8. Push notification campaigns → `/admin/notifications/*`

## What does NOT exist (do not build a frontend flow around these)

- No card/wallet payment gateway is actually wired up — `CARD` and `WALLET` payment methods exist in the schema/enum and are selectable at checkout, but `POST /payments/intent` for them **always throws `501 PAYMENT_PROVIDER_NOT_CONFIGURED`**. Only `CASH` works end-to-end today.
- No "READY" order status (between PREPARING and OUT_FOR_DELIVERY) — the DB enum only has the 6 statuses listed above.
- No saved-address selection at checkout — `CheckoutDto.deliveryAddress` is always an **inline** address object; there is no `addressId` field, even though `/me/addresses` exists as its own feature.
- No image upload wired into categories or promos yet — only `MenuItem.imageUrl` currently accepts a URL from the upload endpoint (categories use a separate `iconUrl` field with the same plain-string contract).
- No password reset / forgot-password endpoint.
- No pagination metadata (total count / hasMore) on any list endpoint — list endpoints return a bare JSON array, with `page`/`limit` as request-side only.
