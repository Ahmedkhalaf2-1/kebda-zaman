# Kebda Zaman API — Integration Guide

Generated directly from the implemented backend code (NestJS + Prisma +
PostgreSQL), not from `BACKEND_IMPLEMENTATION_PLAN.md`. Where the plan and
the actual code disagree, **this document describes the code** — the plan
was the design intent, this is what actually ships. Deviations are called
out explicitly in "Known Backend Integration Notes / Limitations" (§ end).

## A. Base URL

```
http://<host>:3000/api/v1
```

- Local Ubuntu VM / LAN example: `http://192.168.1.51:3000/api/v1`
- Android emulator → host machine: `http://10.0.2.2:3000/api/v1`
- All routes are served under the global prefix `api` + URI version `v1`
  (`app.setGlobalPrefix('api')` + `enableVersioning({ type: URI, defaultVersion: '1' })` in `src/main.ts`).
- **The production base URL is not decided yet.** No domain/TLS exists — see
  `DEPLOYMENT_RUNBOOK.md`. Flutter/Admin must read the base URL from build
  config (`--dart-define=API_BASE_URL=...`), never hardcode it.
- The API binds `0.0.0.0`; CORS origins are an explicit env-configured
  allowlist (`CORS_ORIGINS`) — no wildcards. Mobile apps (no browser
  `Origin` header) are unaffected by CORS; the Admin web panel's exact
  origin must be added to `CORS_ORIGINS`.

## B. Authentication flow

All tokens are issued by `POST /auth/register|login|admin/login|guest` and
rotated by `POST /auth/refresh`. There is one shared JWT/refresh-token
system for customers, guests, and admins — the difference is the `role`
and `isGuest` claims, not a separate mechanism.

1. **Register** — `POST /auth/register` (alias `POST /auth/signup`, identical handler). Creates `role=CUSTOMER, isGuest=false`. Returns `{user, accessToken, refreshToken}`.
2. **Login** — `POST /auth/login`. Same response shape.
3. **Admin login** — `POST /admin/auth/login` (primary) or `POST /auth/admin/login` (alias, identical handler). Rejects a valid, non-admin account with `403 NOT_ADMIN` (see limitations — this differs from the plan's "generic 401" recommendation). Admins are never self-registered; they must be seeded/promoted directly in the DB.
4. **Guest session** — `POST /auth/guest`. Creates a real `User` row with `role=CUSTOMER, isGuest=true`. Returns the same `{user, accessToken, refreshToken}` shape — a guest is a fully functional authenticated principal for every "any authenticated role" route (cart, devices, addresses). Loyalty explicitly rejects guests (403 `GUEST_NOT_ELIGIBLE`); nothing else currently distinguishes guests server-side.
5. **Access token usage** — every non-`@Public()` route requires `Authorization: Bearer <accessToken>`. Missing/invalid/expired token → `401`.
6. **Access token TTL** — `JWT_ACCESS_TTL` env, default **15m**. Stateless JWT, claims `{sub, role, isGuest, jti}`.
7. **Refresh token rotation** — `POST /auth/refresh` with `{refreshToken}` (`@Public()`, no `Authorization` header needed). Every call issues a **new** refresh token and revokes the old one (same `familyId` lineage). Presenting an already-rotated/revoked token is treated as **theft** — the entire lineage is revoked (`403`→ actually `401 REFRESH_TOKEN_REUSED`), forcing re-login on every device in that lineage.
8. **Refresh token TTL** — `JWT_REFRESH_TTL_DAYS` env, default **30 days**. Opaque random string; only its SHA-256 hash is stored server-side.
9. **Logout** — `POST /auth/logout` with optional `{refreshToken}` body (requires `Authorization`). Revokes that one session; silently no-ops if the token is already gone.
10. **Logout all** — `POST /auth/logout-all` (requires `Authorization`, no body). Revokes every active refresh token for the user.
11. **Token expiration behavior** — access token expiry → `401 INVALID_TOKEN` on the next request; Flutter/Admin should catch this and call `/auth/refresh`, then retry once. Refresh token expiry → `401 REFRESH_TOKEN_EXPIRED`, requires full re-login.
12. **Authorization header format** — exactly `Authorization: Bearer <accessToken>` (case-sensitive `Bearer` prefix; `src/common/guards/jwt-access.guard.ts`).
13. **Brute-force lockout** — 5 failed attempts (env `BRUTE_FORCE_MAX_ATTEMPTS`) per `(scope, ip, email)` within 15 minutes (`BRUTE_FORCE_LOCK_MINUTES`) → `423 ACCOUNT_LOCKED` regardless of subsequent correct credentials. `login` and `admin-login` are tracked as separate scopes.

## C. Canonical error response

Every error (validation, business rule, unhandled) returns this exact
shape (`src/common/filters/all-exceptions.filter.ts`):

```json
{
  "statusCode": 400,
  "error": "BadRequest",
  "message": "human readable message",
  "code": "PROMO_EXPIRED",
  "details": { "...optional, e.g. class-validator errors array" },
  "timestamp": "2026-07-24T12:00:00.000Z",
  "path": "/api/v1/promos/validate",
  "requestId": "..."
}
```

- `code` is the stable, machine-readable field Flutter/Admin should branch
  on — never string-match `message`.
- DTO validation failures always use `code: "VALIDATION_ERROR"` with
  `details` as the array of class-validator error strings.
- In production (`NODE_ENV=production`), an unexpected/unhandled server
  error's `message` is always the generic `"Internal server error"` — real
  details are logged server-side only, never returned to the client.
- `requestId` echoes (or generates) `x-request-id` — useful for support/bug
  reports, not required to be sent by the client.

## D. Enums (exact wire values)

| Enum | Values (exact strings) | Where it appears on the wire |
|---|---|---|
| `UserRole` | `CUSTOMER`, `ADMIN` | `User.role` (raw, uppercase) |
| `OrderStatus` (wire form) | `pending`, `confirmed`, `preparing`, `outForDelivery`, `delivered`, `cancelled` | `Order.status`, `?status=` filters, `PATCH /admin/orders/:id/status` body — **lowerCamel, not the DB enum casing**. No `ready` status exists on the wire (see limitations). |
| `DeliveryMethod` | `DELIVERY`, `PICKUP` | `CheckoutDto.deliveryMethod` (request only; not echoed back on `Order`) |
| `PaymentMethod` (Order) | `cash`, `card`, `wallet` | `Order.paymentMethod` — **lowercased** |
| `PaymentMethod` (Payment/DTO) | `CASH`, `CARD`, `WALLET` | `CheckoutDto.paymentMethod` (request), `Payment.method` (response) — **raw uppercase, inconsistent with `Order.paymentMethod` above** |
| `PaymentStatus` | `PENDING`, `PAID`, `FAILED`, `REFUNDED` | `Payment.status`, `PaymentIntentResponseDto.status` — raw uppercase |
| `DiscountType` | `PERCENT`, `FIXED` | `PromoDto.discountType`, promo response `discountType` |
| `DevicePlatform` | `ANDROID`, `IOS`, `WEB`, `MACOS`, `WINDOWS` | device register/update DTOs, `DeviceToken.platform` |
| `CampaignTargetAudience` | `ALL`, `CUSTOMERS`, `GUESTS` | admin campaign DTO/response `targetAudience` |
| `CampaignStatus` | `DRAFT`, `SCHEDULED`, `SENDING`, `SENT`, `FAILED` | admin campaign response `status` |
| `NotificationType` (14 values) | `general`, `promotion`, `offer`, `new_product`, `category`, `order_created`, `order_confirmed`, `order_preparing`, `order_ready`, `order_out_for_delivery`, `order_delivered`, `order_cancelled`, `payment_success`, `payment_failed` | admin campaign DTO `type`; FCM `data.type` payload |
| `OrderItemCustomizationKind` | `VARIANT`, `ADDON` | internal only — surfaced implicitly via `selectedVariant`/`selectedAddons` split, never as a raw string |

## E. Cart and server-side pricing

**Flutter must never compute or submit a price.** Every price-bearing field
in every response (`unitPrice`, `totalPrice`, `basePrice`, `priceDelta`,
`price`, `subtotal`, `tax`, `deliveryFee`, `discount`, `totalAmount`,
`amount`) is computed server-side from the current DB state on every
request — `PricingService` (`src/modules/pricing/pricing.service.ts`) is the
single source of truth. Requests only ever carry references
(`menuItemId`/`variantId`/`addonIds`) and a `quantity`.

- `GET /cart` returns each line's `unitPrice`/`totalPrice` plus flat
  `deliveryFee`/`taxRate` (a passthrough of current `RestaurantSettings` —
  **not yet reduced by delivery method**, since delivery method is chosen
  at checkout, not cart time). **The cart response has no aggregate
  `subtotal`/`total` field** — Flutter must sum `items[].totalPrice`
  client-side for cart-screen display, but that sum is only a preview; the
  authoritative total is computed again at checkout and returned on the
  `Order`.
- A stale cart line (item/variant/addon made unavailable after being added)
  is still returned with `isAvailable: false` and a zeroed price — never
  silently dropped. The customer must be able to see and remove it. Do not
  allow checkout to proceed while any line has `isAvailable: false`
  (checkout re-validates strictly and will `422` anyway).
- `POST /cart/items` and `PUT /cart/items/:id` validate strictly and `404`/`422` on an invalid selection — no stale line is ever created by a mutation, only by a catalog change happening after the fact.

## F. Checkout

`POST /orders` and `POST /checkout` are the same handler — pick either;
they are 100% equivalent. Request body carries **no monetary fields**.

- `deliveryMethod: "DELIVERY" | "PICKUP"` (required).
- `paymentMethod: "CASH" | "CARD" | "WALLET"` (required, raw uppercase — see enum table).
- `deliveryAddress` — **required when `deliveryMethod=DELIVERY`** (`{title, street, building, floor?, apartment?, city}`), else `422 DELIVERY_ADDRESS_REQUIRED`. When `PICKUP`, omit it — the order's stored `deliveryAddress` becomes `{"type":"PICKUP"}`.
- `promoCode` — optional string; server re-evaluates it against the caller's real cart (client-sent subtotal, if any, is ignored everywhere promo codes are evaluated).
- `notes` — optional string, stored only on the first `OrderStatusHistory` entry (no dedicated `Order.notes` column).
- **`Idempotency-Key` header** (optional, any string) — send the same value to retry a checkout call safely (e.g. after a timeout) without creating a duplicate order; the server namespaces it per-user internally. Omitting it means every call creates a new order attempt.
- Cart must be non-empty (`409 EMPTY_CART`), and the priced subtotal must meet `RestaurantSettings.minOrderAmount` (`422 BELOW_MIN_ORDER`).
- A promo that's expired/inactive/exhausted/below its own min-order fails with `404 PROMO_NOT_FOUND` / `422 PROMO_INVALID` / `422 PROMO_EXPIRED` / `422 PROMO_MIN_ORDER` respectively — checkout does **not** silently drop an invalid promo, it fails the whole request.
- On success: cart is cleared, a `Payment(status=PENDING)` row is created alongside the `Order`, and the response is the full `Order` (see Customer Orders group for shape).

## G. Payments

- **CASH**: `POST /payments/intent` for a CASH order is a no-op round-trip — it returns `{paymentId, status:"PENDING", providerData:{instructions:"Pay with cash upon delivery"}}` and changes nothing. The `Payment` stays `PENDING` until an ADMIN transitions the order to `delivered` (`PATCH /admin/orders/:id/status`), at which point the backend automatically settles it to `PAID` — **there is no customer-facing "mark as paid" call**.
- **CARD/WALLET**: `POST /payments/intent` currently always returns `501` with `code: "PAYMENT_PROVIDER_NOT_CONFIGURED"` — no real gateway is wired up yet. Flutter should treat CARD/WALLET as **not currently available** and either hide those options or show a clear "coming soon" state; do not build UI that assumes a redirect/iframe/token flow exists today.
- **Payment status flow**: `PENDING → PAID | FAILED` (CASH: via delivery, CARD/WALLET: would be via webhook once a gateway exists) then `PAID → REFUNDED` (no endpoint triggers this yet). `GET /payments/:id` (owner or ADMIN) returns the current `Payment` row.
- **`POST /payments/webhook` is SERVER/GATEWAY infrastructure — Flutter/Admin must never call it.** It's `@Public()` (no JWT) because a real payment gateway would call it directly with its own signature scheme; today it always fails (`400 UNKNOWN_PAYMENT_PROVIDER` or `400 INVALID_WEBHOOK_SIGNATURE`) because no gateway is registered. It exists purely as forward-compatible plumbing.
- Never trust a client-supplied amount anywhere in this flow — `POST /payments/intent` takes only `{orderId}`; the amount always comes from the `Payment` row created at checkout.

## H. FCM / device-token flow

- **Register**: call `POST /devices/register` with `{token, platform}` right after the FCM token becomes available (app start, and again whenever Firebase's `onTokenRefresh` fires) — for both logged-in and guest sessions (any authenticated principal works; guests are fine). This is an upsert keyed on the token: re-registering the same token from a different logged-in user re-attaches it to that user (device changed hands).
- **Rotate**: when the FCM SDK reports a token refresh with a known previous value, prefer `PUT /devices/token` with `{oldToken, token, platform}` over calling register twice — it atomically moves the row instead of leaving a stale entry. If there's no known previous token, `PUT` with only `{token, platform}` behaves like register.
- **Delete**: call `DELETE /devices/token` with `{token}` on explicit logout / notification opt-out. A token you don't own (registered by a different logged-in user) returns `404`, not `403` — existence isn't leaked.
- **Notification payload Flutter must handle** — the FCM `data` map (never the `notification` block; every push is data-only) has exactly these keys, matching `AppNotificationPayload`: `id`, `type` (one of the 14 `NotificationType` values), `title`, `body`, and optionally `route`, `entityId`, `imageUrl`, `timestamp`. Order-status pushes set `route: "/orders/tracking/{orderId}"` and `entityId: "{orderId}"` — use `route` for deep-linking, don't hardcode a route table from `type` alone since admin campaigns can set an arbitrary `route`.
- There is **no `GET /me/notifications` history/inbox endpoint** — notification history is local-only on the client (see limitations).

## I. Admin integration

Every route under `/admin/*` requires `@Roles('ADMIN')` — a valid access
token whose `role` claim is `ADMIN`, obtained only via `POST /admin/auth/login`
(or its alias). A `CUSTOMER`-role token (including guests, who are also
`CUSTOMER`) gets `403 FORBIDDEN` on every one of these. There is no
separate "admin token type" — it's the same JWT format with `role: "ADMIN"`.

Admin-only route groups: Admin Orders, Admin Categories, Admin Menu, Admin
Promo Codes, Admin Restaurant Settings, Admin Notification Campaigns (all
detailed below). There is currently **no admin dashboard/stats endpoint**
(`/admin/dashboard/*` from the plan was never implemented) — see
limitations.

## J. Flutter integration notes — feature → repository mapping

| Backend feature | Recommended Flutter repository/service |
|---|---|
| §2 Auth (register/login/guest/refresh/logout) | `ApiAuthRepository` — owns token storage + refresh-on-401 retry logic |
| §4 Public Catalog | `ApiMenuRepository` (categories, menu list/detail/search, featured) |
| §5 Cart | `ApiCartRepository` — every mutation returns the full `Cart`, so this repo can just replace local state wholesale on each call |
| §6 Promotions validation | folded into `ApiCartRepository` / a thin `ApiPromoRepository` — `POST /promos/validate` is a preview-only check; actual application happens via `POST /cart/apply-promo` |
| §7 Restaurant Settings (public) | `ApiSettingsRepository` — poll or fetch once per session for delivery fee/tax/min-order/hours/maintenance-mode display |
| §8 Checkout | `ApiOrderRepository.checkout()` |
| §9 Customer Orders | `ApiOrderRepository` (list/detail/status) |
| §10 Device Tokens | `ApiDeviceRepository`, driven by the existing `syncTokenWithBackend` hook |
| §11 Payments | `ApiPaymentRepository` — CASH-only UI for now |
| §12 Addresses | `ApiAddressRepository` |
| §13 Favorites | `ApiFavoritesRepository` |
| §14 Loyalty | `ApiLoyaltyRepository` |
| §15-20 Admin groups | corresponding `Api*Repository` in the **Admin Panel** codebase only, gated on an ADMIN-role session |

## K. Fake-data replacement checklist (migration order)

1. **Auth** — swap `FakeAuthRepository` once register/login/refresh/logout/guest are verified end-to-end.
2. **Catalog** — swap `FakeMenuRepository` once categories/menu/search/featured match the `MenuItem`/`Category` contract exactly (variant/addon shape included).
3. **Cart** — swap `FakeCartRepository` once server-priced totals match the UI's own display math (remembering the cart has no aggregate total field — see §E).
4. **Checkout/Orders** — swap `FakeOrderRepository` once checkout + list/detail/status tracking are verified, including the `Idempotency-Key` retry path.
5. **Devices/FCM** — activate `syncTokenWithBackend` → `POST /devices/register`, verify payload `type`/`route` handling against §H.
6. **Addresses/Favorites/Loyalty** — swap these three repos (independent of each other; any order).
7. **Admin Panel** — point every admin provider at `/admin/*` last, after the customer app is fully validated against the same backend.

Do not delete a `Fake*Repository` until its `Api*` replacement has run
against this real backend in a real environment and no screen still
references the fake.

---

# Endpoint Reference

Every endpoint below is documented from the actual controller/DTO/mapper
code. "Auth" states what the route actually enforces (not what the plan
says). Unless noted, all bodies are JSON and all responses are JSON.

## 1. Health

### `GET /health`
- Auth: Public.
- Liveness only — no dependency checks.
- Response `200`: `{ "status": "ok", "info": {}, "error": {}, "details": {} }`

### `GET /health/ready`
- Auth: Public.
- Includes a real PostgreSQL ping.
- Response `200` (DB up): `{ "status": "ok", "info": {"database":{"status":"up"}}, "error": {}, "details": {"database":{"status":"up"}} }`
- Response `503` (DB down): Terminus's standard `ServiceUnavailableException` shape, `status: "error"`.

## 2. Authentication

### `POST /auth/register` (alias `POST /auth/signup`)
- Auth: Public. Throttled: 20 req/60s.
- Body: `{ name: string (2-100), email: string (valid email, ≤255), password: string (8-72), phone?: string (≤30) }` — all but `phone` required.
- Response `201`: `{ user: UserResponseDto, accessToken: string, refreshToken: string }`
- Errors: `400` validation, `409 EMAIL_ALREADY_EXISTS`.

### `POST /auth/login`
- Auth: Public. Throttled: 20 req/60s.
- Body: `{ email: string, password: string (1-72) }`
- Response `200`: same `AuthResult` shape as register.
- Errors: `401 INVALID_CREDENTIALS`, `423 ACCOUNT_LOCKED`.

### `POST /admin/auth/login` (primary) / `POST /auth/admin/login` (alias)
- Auth: Public. Throttled: 20 req/60s.
- Body: identical to login.
- Response `200`: `AuthResult`, only for a `role=ADMIN` account.
- Errors: `401 INVALID_CREDENTIALS` (bad password / unknown email), `403 NOT_ADMIN` (correct password, non-admin account — **note: this reveals the account exists**, see limitations), `423 ACCOUNT_LOCKED`.

### `POST /auth/refresh`
- Auth: Public (send `refreshToken` in the body, not a header).
- Body: `{ refreshToken: string }`
- Response `200`: `{ accessToken: string, refreshToken: string }` (new refresh token — replace the stored one).
- Errors: `401 INVALID_REFRESH_TOKEN`, `401 REFRESH_TOKEN_REUSED`, `401 REFRESH_TOKEN_EXPIRED`.

### `POST /auth/logout`
- Auth: Access token required.
- Body: `{ refreshToken?: string }` (optional — omit to no-op).
- Response: `204`.

### `POST /auth/logout-all`
- Auth: Access token required. No body.
- Response: `204`.

### `POST /auth/guest`
- Auth: Public. No throttle override (uses global default).
- Body: `{ deviceId?: string }` (accepted, currently not used server-side).
- Response `201`: `AuthResult` for a `role=CUSTOMER, isGuest=true` user.

## 3. User / Profile

### `GET /users/me`
- Auth: Access token required (any role).
- Response `200`: `UserResponseDto` — `{ id, name, email, phone, avatarUrl, role, isGuest, locale, createdAt }`. Note: DB field `fullName` is mapped to JSON key `name`.

### `PATCH /users/me`
- Auth: Access token required.
- Body (all optional, full-replace of only provided fields): `{ name?: string (2-100), phone?: string (≤30), avatarUrl?: string (≤2048), locale?: "ar"|"en" }`
- Response `200`: `UserResponseDto`.

## 4. Public Catalog / Categories / Menu / Search / Featured

### `GET /categories`
- Auth: Public.
- Response `200`: `CategoryResponseDto[]` — `{ id, nameAr, nameEn, iconUrl, displayOrder }[]`, active only, ordered by `displayOrder`.

### `GET /categories/:id`
- Auth: Public. Path param: `id` (UUID).
- Response `200`: `CategoryResponseDto`. Errors: `404 CATEGORY_NOT_FOUND`.

### `GET /menu`
- Auth: Public.
- Query: `categoryId?` (UUID), `page?` (int ≥1, default 1), `limit?` (int 1-100, default 20).
- Response `200`: `MenuItemResponseDto[]` (see shape below). Available items only, no envelope/total-count — pagination is offset-based (`skip`/`take`), no `X-Total-Count` header.

### `GET /menu/search`
- Auth: Public.
- Query: `q` (required, non-empty, ≤200).
- Response `200`: `MenuItemResponseDto[]`. Errors: `400 SEARCH_QUERY_EMPTY` (empty/whitespace-only `q` bypasses DTO validation and is caught service-side).

### `GET /menu/items/:id`
- Auth: Public. Path param: `id` (UUID).
- Response `200`: `MenuItemResponseDto` (full, unpaginated). Errors: `404 MENU_ITEM_NOT_FOUND`.

### `GET /home/featured`
- Auth: Public.
- Response `200`: `{ featured: MenuItemResponseDto[] (up to 10, isPopular=true), categories: CategoryResponseDto[] (all active) }`

**`MenuItemResponseDto` shape** (public, used by `/menu`, `/menu/search`, `/menu/items/:id`, `/home/featured`, cart line hydration, and favorites list):
```json
{
  "id": "uuid", "categoryId": "uuid",
  "nameAr": "string", "nameEn": "string",
  "descriptionAr": "string", "descriptionEn": "string",
  "basePrice": 25.5, "imageUrl": "string",
  "isAvailable": true, "isPopular": false,
  "variants": [{ "id": "uuid", "nameAr": "..", "nameEn": "..", "priceDelta": 10, "isDefault": true }],
  "addonGroups": [{ "id": "uuid", "titleAr": "..", "titleEn": "..", "isRequired": false, "minSelect": 0, "maxSelect": 1,
    "addons": [{ "id": "uuid", "nameAr": "..", "nameEn": "..", "price": 5 }] }]
}
```
Only `isActive` variants and `isAvailable` addons are included publicly.

## 5. Cart

All routes require an access token (any role — guests included, "guest-ok"). No `/cart` route is `@Public()`.

### `GET /cart`
- Response `200`: `CartResponseDto` — `{ items: CartItemResponseDto[], appliedPromo: PromoResponseDto|null, deliveryFee: number, taxRate: number }`. **No aggregate subtotal/total field** (see §E).

### `POST /cart/items`
- Body: `{ menuItemId: string(UUID), variantId?: string(UUID), addonIds?: string[](UUIDs), quantity: int ≥1, specialInstructions?: string(≤500) }`
- Response `201`: `CartResponseDto` (the whole cart, not just the new line).
- Errors: `404 ITEM_UNAVAILABLE`, `422 INVALID_VARIANT`, `422 INVALID_ADDON_SELECTION` (wrong addon-group min/max or unowned addon).

### `PUT /cart/items/:id`
- Path param: `id` (cart item UUID, owner-scoped).
- Body (all optional — patch semantics): `{ quantity?: int≥1, variantId?: string|null, addonIds?: string[], specialInstructions?: string|null }`. Omitted fields keep their current value; `addonIds` (even `[]`) fully replaces the addon set when present.
- Response `200`: `CartResponseDto`. Errors: `404 CART_ITEM_NOT_FOUND`, `422 INVALID_VARIANT`/`INVALID_ADDON_SELECTION`.

### `DELETE /cart/items/:id`
- Response `200`: `CartResponseDto` (not `204` — the route returns the updated cart). Errors: `404 CART_ITEM_NOT_FOUND`.

### `POST /cart/apply-promo`
- Body: `{ code: string (≤50) }`
- Response `200`: `CartResponseDto` with `appliedPromo` populated.
- Errors: `404 PROMO_NOT_FOUND`, `422 PROMO_INVALID`/`PROMO_EXPIRED`/`PROMO_MIN_ORDER`.

### `DELETE /cart/promo`
- Response `200`: `CartResponseDto` with `appliedPromo: null`.

### `DELETE /cart`
- Response `200`: `CartResponseDto` with `items: []` (clears every line, keeps any applied promo association at the cart row — note: does not explicitly clear `appliedPromoId`).

**`CartItemResponseDto`**:
```json
{
  "id": "uuid", "menuItem": { "...MenuItemResponseDto" },
  "selectedVariant": { "id":"uuid","nameAr":"..","nameEn":"..","priceDelta":10,"isDefault":true } ,
  "selectedAddons": [{ "id":"uuid","nameAr":"..","nameEn":"..","price":5 }],
  "quantity": 2, "specialInstructions": null,
  "unitPrice": 30.5, "totalPrice": 61, "isAvailable": true
}
```

## 6. Promotions validation

### `POST /promos/validate`
- Auth: Access token required (any role). Throttled: 20 req/60s.
- Body: `{ code: string(≤50), subtotal?: number }` — **`subtotal` is accepted but ignored**; the server always prices the caller's real current cart.
- Response `200`: `{ valid: true, discountType: "PERCENT"|"FIXED", value: number, computedDiscount: number }`
- Errors: `404 PROMO_NOT_FOUND`, `422 PROMO_INVALID`/`PROMO_EXPIRED`/`PROMO_MIN_ORDER`.
- This is a **preview-only** check — it does not attach the promo to the cart. Use `POST /cart/apply-promo` to actually apply it.

## 7. Restaurant Settings (public)

### `GET /settings`
- Auth: Public.
- Response `200`: `{ deliveryFee: number, taxRatePercent: number, minOrderAmount: number, workingHours: {open:"HH:MM", close:"HH:MM"}, isMaintenanceMode: boolean }`
- There is no client-side enforcement of `isMaintenanceMode` — Flutter must check this flag itself and show a maintenance screen if true; the backend does not block other endpoints when it's set.

## 8. Checkout

### `POST /orders` / `POST /checkout` (identical handler, both real routes)
- Auth: `CUSTOMER` role only (this also covers guests, whose role is `CUSTOMER`).
- Headers: `Idempotency-Key?: string` (recommended for retry-safety — see §F).
- Body: `{ deliveryMethod: "DELIVERY"|"PICKUP", paymentMethod: "CASH"|"CARD"|"WALLET", deliveryAddress?: {title,street,building,floor?,apartment?,city}, promoCode?: string(≤50), notes?: string(≤1000) }`
- Response `201`: `OrderResponseDto` (see Customer Orders group).
- Errors: `422 DELIVERY_ADDRESS_REQUIRED`, `409 EMPTY_CART`, `422 BELOW_MIN_ORDER`, `404/422` promo errors (§6), `404 ITEM_UNAVAILABLE` / `422 INVALID_VARIANT`/`INVALID_ADDON_SELECTION` (a line went stale between cart-view and checkout).

## 9. Customer Orders

### `GET /orders`
- Auth: `CUSTOMER` role.
- Query: `status?` (one of the lowerCamel `OrderStatus` wire values), `page?` (≥1, default 1), `limit?` (≥1, default 20, **no upper cap enforced here** — unlike admin's list).
- Response `200`: `OrderResponseDto[]`, newest first.

### `GET /orders/:id`
- Auth: `CUSTOMER` role, owner-scoped (404 if not owner — not 403, existence not leaked).
- Response `200`: `OrderResponseDto`.

### `GET /orders/:id/status`
- Auth: `CUSTOMER` role, owner-scoped.
- Response `200`: `{ status: string(lowerCamel), statusHistory: [{status,note,changedAt}], estimatedDeliveryTime: string|null }`
- **There is no `GET /orders/:id/stream` SSE endpoint and no `POST /orders/:id/cancel` endpoint** — poll this route for tracking; customers cannot self-cancel (see limitations).

**`OrderResponseDto`**:
```json
{
  "id": "uuid", "orderNumber": "KZ-260724-a1b2c3d4", "userId": "uuid",
  "user": { "...UserResponseDto" },
  "items": [{ "id":"uuid", "menuItem": {"nameAr":"..","nameEn":"..","imageUrl":".."},
    "selectedVariant": {"id":"uuid","nameAr":"..","nameEn":"..","priceSnapshot":10}|null,
    "selectedAddons": [{"id":"uuid","nameAr":"..","nameEn":"..","priceSnapshot":5}],
    "quantity": 2, "specialInstructions": null, "unitPrice": 30.5, "totalPrice": 61 }],
  "status": "pending",
  "deliveryAddress": { "title":"..","street":"..","building":"..","floor":null,"apartment":null,"city":".." } ,
  "paymentMethod": "cash",
  "subtotal": 120, "deliveryFee": 20, "tax": 16.8, "discount": 0, "totalAmount": 156.8,
  "createdAt": "2026-07-24T12:00:00.000Z", "estimatedDeliveryTime": null
}
```
`items[].menuItem`/`selectedVariant`/`selectedAddons` are **immutable snapshots** taken at order time — they never reflect later catalog edits, and `menuItem` here has only `{nameAr,nameEn,imageUrl}` (not the full public shape). `deliveryAddress` is `{"type":"PICKUP"}` for pickup orders.

## 10. Device Tokens / FCM

All routes require an access token (any role, guest-ok).

### `POST /devices/register`
- Body: `{ token: string(≤4096), platform: "ANDROID"|"IOS"|"WEB"|"MACOS"|"WINDOWS" }`
- Response `201`: raw `DeviceToken` row — `{ id, userId, token, platform, lastSeenAt, isActive, createdAt, updatedAt }`.
- Upserts by `token`; always re-attaches to the calling user.

### `PUT /devices/token`
- Body: `{ oldToken?: string(≤4096), token: string(≤4096), platform: "..." }`
- Response `200`: `DeviceToken` (same shape as above). Without `oldToken`, behaves exactly like register.
- Errors: `404 DEVICE_TOKEN_NOT_FOUND` (unknown `oldToken`, or one owned by another user).

### `DELETE /devices/token`
- Body: `{ token: string(≤4096) }`
- Response: `204`. Errors: `404 DEVICE_TOKEN_NOT_FOUND`.

## 11. Payments

### `POST /payments/intent`
- Auth: `CUSTOMER` role.
- Body: `{ orderId: string(UUID) }`
- Response `201`: `{ paymentId: string, status: "PENDING"|"PAID"|"FAILED"|"REFUNDED", providerData?: object }` — for CASH, `providerData: {instructions:"Pay with cash upon delivery"}`.
- Errors: `404 ORDER_NOT_FOUND` (not found or not yours), `404 PAYMENT_NOT_FOUND`, `409 PAYMENT_ALREADY_PROCESSED` (payment isn't `PENDING` anymore), `501 PAYMENT_PROVIDER_NOT_CONFIGURED` (CARD/WALLET, always today).

### `GET /payments/:id`
- Auth: Access token required; owner or ADMIN (404 for anyone else — not leaked).
- Response `200`: `{ id, orderId, method:"CASH"|"CARD"|"WALLET", status:"PENDING"|"PAID"|"FAILED"|"REFUNDED", amount:number, currency:string, provider:string|null, providerRef:string|null, createdAt, updatedAt }`

### `POST /payments/webhook` — **SERVER/GATEWAY ONLY, do not call from Flutter/Admin**
- Auth: Public. Throttled: 20 req/60s.
- Query: `provider` (required string).
- Body: raw gateway payload (currently accepted as arbitrary JSON).
- Response `200`: `{ received: true }` once a real provider exists; today always errors — `400 UNKNOWN_PAYMENT_PROVIDER` or `400 INVALID_WEBHOOK_SIGNATURE`.

## 12. Addresses

All routes require an access token (any role).

### `GET /me/addresses`
- Response `200`: `AddressResponseDto[]`, oldest first.

### `POST /me/addresses`
- Body: `{ title:string(≤100), street:string(≤200), building:string(≤100), floor?:string(≤50), apartment?:string(≤50), city:string(≤100), notes?:string(≤1000), latitude?:number, longitude?:number, isDefault?:boolean }`
- Response `201`: `AddressResponseDto`. **The first address a user creates is always forced to `isDefault:true`** regardless of the submitted value; subsequent creates respect `isDefault` (unsetting any previous default).

### `PUT /me/addresses/:id`
- Body: same as create (full replace).
- Response `200`: `AddressResponseDto`. Errors: `404 ADDRESS_NOT_FOUND` (no such id), `403 FORBIDDEN` (exists, belongs to someone else — **note: this leaks existence**, unlike the 404-only pattern used elsewhere).

### `DELETE /me/addresses/:id`
- Response: `204`. Same `404`/`403` errors as above. No auto-promotion of another address to default after deleting the current default.

### `PATCH /me/addresses/:id/default`
- Response `200`: `AddressResponseDto` with `isDefault:true`; unsets any other default for that user. Same `404`/`403` errors.

**`AddressResponseDto`**: `{ id, userId, title, street, building, floor, apartment, city, notes, latitude, longitude, isDefault, createdAt, updatedAt }`.

## 13. Favorites

All routes require `CUSTOMER` role (guests included, since guests are `CUSTOMER`).

### `GET /me/favorites`
- Response `200`: `MenuItemResponseDto[]`, most-recently-favorited first.

### `POST /me/favorites`
- Body: `{ menuItemId: string(UUID) }`
- Response `201`: **the full updated `MenuItemResponseDto[]` favorites list**, not just the added item.
- Errors: `404 MENU_ITEM_NOT_FOUND`, `409 FAVORITE_ALREADY_EXISTS`.

### `DELETE /me/favorites/:menuItemId`
- Response: `204`. Errors: `404 FAVORITE_NOT_FOUND`.

## 14. Loyalty

All routes require `CUSTOMER` role AND `isGuest=false` — a guest gets `403 GUEST_NOT_ELIGIBLE` even though guests are `CUSTOMER`-role.

### `GET /me/loyalty`
- Response `200`: `{ id, userId, pointsBalance: number, createdAt, updatedAt }`. Lazily creates the account (balance 0) on first call.

### `GET /me/loyalty/transactions`
- Response `200`: `{ id, delta: number, reason: string, orderId: string|null, createdAt }[]`, newest first. `reason` is a free string, currently either `"ORDER_EARNED"` (positive `delta`) or `"REDEMPTION"` (negative `delta`) — not a Prisma enum, so treat as an open string set.

### `POST /me/loyalty/redeem`
- Body: `{ rewardId: string }` — **no numeric points field accepted**; unknown/extra fields are rejected (`400`, `whitelist`/`forbidNonWhitelisted` validation).
- Valid `rewardId` values today (hardcoded catalog, not fetchable via any endpoint — see limitations): `"free-delivery"` (100 pts), `"discount-10"` (150 pts), `"discount-25"` (350 pts).
- Response `201`: `{ account: {...LoyaltyAccountResponseDto}, redemption: { rewardId, rewardName, pointsCost, transactionId, redeemedAt } }`
- Errors: `404 REWARD_NOT_FOUND`, `422 INSUFFICIENT_POINTS`.
- Points are earned automatically: 1 point per 10 currency units of an order's final `totalAmount`, credited only when an ADMIN marks that order `delivered` — never for cancelled/failed orders, never guest orders, never double-credited for the same order.

## 15. Admin Orders

All routes require `ADMIN` role.

### `GET /admin/orders`
- Query: `status?`, `q?` (free-text over order number / customer name / email, ≤100), `page?` (default 1), `limit?` (1-100, default 20).
- Response `200`: `OrderResponseDto[]`, any customer's orders.

### `GET /admin/orders/:id`
- Response `200`: `OrderResponseDto`, no ownership restriction. Errors: `404 ORDER_NOT_FOUND`.

### `PATCH /admin/orders/:id/status`
- Body: `{ status: "pending"|"confirmed"|"preparing"|"outForDelivery"|"delivered"|"cancelled", note?: string(≤1000) }`
- Allowed transitions only: `pending→confirmed|cancelled`, `confirmed→preparing|cancelled`, `preparing→outForDelivery|cancelled`, `outForDelivery→delivered|cancelled`. `delivered` and `cancelled` are terminal (no further transitions, including no reopening).
- Response `200`: `OrderResponseDto`. Errors: `404 ORDER_NOT_FOUND`, `422 INVALID_STATUS_TRANSITION`.
- Side effects on `delivered`: CASH payment auto-settles to `PAID`, loyalty points are credited. On every transition: an order-status push notification is attempted (failure is logged, never rolls back or fails the request).

## 16. Admin Categories

All routes require `ADMIN` role.

### `GET /admin/categories`
- Response `200`: `AdminCategoryResponseDto[]` (`CategoryResponseDto` + `isActive`), includes inactive ones, excludes soft-deleted.

### `POST /admin/categories`
- Body: `{ nameAr:string(≤100), nameEn:string(≤100), iconUrl?:string(≤2048), displayOrder?:int≥0 }`
- Response `201`: `AdminCategoryResponseDto`.

### `PUT /admin/categories/:id`
- Body: same as create (full replace). Response `200`. Errors: `404 CATEGORY_NOT_FOUND`.

### `DELETE /admin/categories/:id`
- Response: `204` (soft delete: `deletedAt` set, `isActive:false`).
- Errors: `404 CATEGORY_NOT_FOUND`, `409 CATEGORY_HAS_ITEMS` (blocked while any active menu item still references it).

## 17. Admin Menu / Variants / Add-on Groups / Add-ons

All routes require `ADMIN` role. Variants/add-on groups/add-ons are managed **inline** on the menu item — there are no separate `/admin/menu/items/:id/variants` etc. endpoints.

### `GET /admin/menu`
- Query: `categoryId?`, `q?` (≤150).
- Response `200`: `AdminMenuItemResponseDto[]` — includes unavailable/soft-deleted-excluded items, every variant/addon (not just active/available ones), plus `displayOrder` on every level.

### `POST /admin/menu/items`
- Body (`MenuItemDto`): `{ categoryId:UUID, nameAr:string(≤150), nameEn:string(≤150), descriptionAr:string, descriptionEn:string, basePrice:number≥0, imageUrl:string(≤2048), isAvailable?:bool, isPopular?:bool, displayOrder?:int≥0, variants?: VariantDto[], addonGroups?: AddonGroupDto[] }`
  - `VariantDto`: `{ id?(update-only), nameAr, nameEn, priceDelta:number, isDefault?, isActive?, displayOrder? }`
  - `AddonGroupDto`: `{ id?, titleAr, titleEn, isRequired?, minSelect?, maxSelect?, displayOrder?, addons: AddonDto[] }`
  - `AddonDto`: `{ id?, nameAr, nameEn, price:number≥0, isAvailable?, displayOrder? }`
- Response `201`: `AdminMenuItemResponseDto`. Errors: `422 INVALID_CATEGORY`.

### `PUT /admin/menu/items/:id`
- Body: same `MenuItemDto`, **full replace with diff-sync semantics**: a `variants`/`addonGroups` entry with an `id` updates in place; without an `id` it's created; any existing row not present in the submitted array is **deleted**. All inside one transaction.
- Response `200`: `AdminMenuItemResponseDto`.
- Errors: `404 MENU_ITEM_NOT_FOUND`, `422 INVALID_CATEGORY`, `422 INVALID_VARIANT_ASSOCIATION`/`INVALID_ADDON_GROUP_ASSOCIATION`/`INVALID_ADDON_ASSOCIATION` (an `id` submitted that doesn't belong to this item/group), `409 MENU_ENTITY_IN_USE` (attempted to delete a variant/addon still referenced by an active cart line).

### `PATCH /admin/menu/items/:id/availability`
- Body: `{ isAvailable: boolean }`
- Response `200`: `AdminMenuItemResponseDto`. Errors: `404 MENU_ITEM_NOT_FOUND`.

### `DELETE /admin/menu/items/:id`
- Response: `204` (soft delete: `deletedAt` set, `isAvailable:false`). Errors: `404 MENU_ITEM_NOT_FOUND`.

## 18. Admin Promo Codes

All routes require `ADMIN` role.

### `GET /admin/promos`
- Response `200`: `AdminPromoResponseDto[]` — `{ code, discountType, value, minOrderAmount, maxDiscountAmount, id, maxUsage, usageCount, perUserLimit, startsAt, expiresAt, isActive, createdAt, updatedAt }`, newest first, excludes soft-deleted.

### `POST /admin/promos`
- Body (`PromoDto`): `{ code:string(≤50), discountType:"PERCENT"|"FIXED", value:number≥0, minOrderAmount?:number≥0, maxDiscountAmount?:number≥0, maxUsage?:int≥1, perUserLimit?:int≥1, startsAt?:ISO date string, expiresAt?:ISO date string, isActive?:bool }`
- `code` is normalized (`trim().toUpperCase()`) before storage/comparison.
- Response `201`: `AdminPromoResponseDto`. Errors: `409 PROMO_CODE_EXISTS`.

### `PUT /admin/promos/:id`
- Body: same `PromoDto` (full replace). Response `200`. Errors: `404 PROMO_NOT_FOUND`, `409 PROMO_CODE_EXISTS` (renamed to a code already used by another active promo).

### `DELETE /admin/promos/:id`
- Response: `204` (soft delete). Takes effect immediately for `/promos/validate` and checkout (both filter `deletedAt:null`). Errors: `404 PROMO_NOT_FOUND`.

## 19. Admin Restaurant Settings

All routes require `ADMIN` role. There is a single settings row (singleton) — no create/delete, only read/replace.

### `GET /admin/settings`
- Response `200`: `{ id, restaurantName, phone, addressText, deliveryFee, taxRatePercent, minOrderAmount, currency, workingHours, isMaintenanceMode, updatedAt }`

### `PUT /admin/settings`
- Body (full replace, **every** field required): `{ restaurantName:string(≤200), phone:string(≤50), addressText:string(≤500), taxRatePercent:number(0-100), deliveryFee:number≥0, minOrderAmount:number≥0, currency:string(≤10), workingHours:{open:"HH:MM",close:"HH:MM"} (24h regex-validated), isMaintenanceMode:boolean }`
- Response `200`: same shape as GET. No `400` field-level partial-update path exists — omitting any field fails whole-body validation.

## 20. Admin Notification Campaigns

All routes require `ADMIN` role.

### `POST /admin/notifications/send`
- Body (`CampaignDto`): `{ campaignName:string(≤150), title:string(≤150), body:string(≤1000), imageUrl?:string(≤2048), type: one of the 14 NotificationType values, targetAudience?:"ALL"|"CUSTOMERS"|"GUESTS" (default "ALL"), destinationRoute?:string(≤500), entityId?:string(≤100) }`
- Response `201`: `AdminCampaignResponseDto` with `status` settled to `"SENT"` or `"FAILED"` (dispatch happens synchronously in the request).
- A send failure (e.g. FCM unavailable) never crashes the request — the campaign is persisted `FAILED` and the response still returns `201`.

### `POST /admin/notifications/schedule`
- Body: `CampaignDto` + `{ scheduledAt: ISO date string }`
- Response `201`: `AdminCampaignResponseDto` with `status:"SCHEDULED"`. A background poller (every 60s) dispatches it once due — see limitations for the multi-instance note.

### `GET /admin/notifications/campaigns`
- Query: `page?` (≥1, default 1; fixed page size of 20, not configurable).
- Response `200`: `AdminCampaignResponseDto[]`, newest first.

### `DELETE /admin/notifications/campaigns/:id`
- Response: `204`. Only `DRAFT`/`SCHEDULED` campaigns are deletable. Errors: `404 CAMPAIGN_NOT_FOUND`, `409 CAMPAIGN_NOT_DELETABLE` (already sending/sent/failed).

**`AdminCampaignResponseDto`**: `{ id, campaignName, title, body, imageUrl, type, targetAudience, destinationRoute, entityId, status, isScheduled, scheduledAt, sentAt, totalRecipients, deliveredCount, openedCount, clickRate, createdAt }`. `openedCount`/`clickRate` are always `0` today — nothing reports opens/clicks back to the server yet.

---

## 1. Flutter Integration Checklist

- [ ] Base URL from build-time config, never hardcoded (§A).
- [ ] `Authorization: Bearer <token>` on every non-public call; central 401 → refresh → retry-once interceptor (§B).
- [ ] Store refresh token securely (`flutter_secure_storage`); access token in memory only.
- [ ] Error handling keyed on `code`, not `message` (§C).
- [ ] Never compute/send a price; always render server-returned `unitPrice`/`totalPrice`/`totalAmount` (§E).
- [ ] Cart screen sums `items[].totalPrice` itself for a live subtotal preview — the cart endpoint doesn't provide one.
- [ ] `Idempotency-Key` header on checkout retries (§F).
- [ ] CARD/WALLET payment UI gated off or marked unavailable until a real gateway exists (§G).
- [ ] Never call `/payments/webhook`.
- [ ] FCM: register on token-available/refresh, rotate via `PUT /devices/token` when the old token is known, delete on logout (§H).
- [ ] Handle both `route`-based deep-linking and the 14 fixed `type` values from campaign/order pushes.
- [ ] No local assumption of an order `ready` status or a cancel/SSE endpoint — poll `GET /orders/:id/status` (§9, limitations).
- [ ] Loyalty screens must handle `403 GUEST_NOT_ELIGIBLE` for guest sessions.

## 2. Admin Panel Integration Checklist

- [ ] Login exclusively via `POST /admin/auth/login`; handle `403 NOT_ADMIN` distinctly from `401 INVALID_CREDENTIALS` in the login form's error message.
- [ ] Every `/admin/*` call needs an ADMIN-role access token; a stale CUSTOMER-role token must trigger re-login, not a silent failure.
- [ ] Menu item editor must implement diff-sync semantics correctly: omitting an existing variant/addon-group/addon `id` from the submitted array **deletes** it server-side (§17) — the UI must submit the complete current set, not just changed rows.
- [ ] Settings form is full-replace only — submit every field every time, no partial `PATCH`.
- [ ] Campaign send is synchronous from the caller's perspective (blocks until dispatched) — show a loading state, not a fire-and-forget toast.
- [ ] There is no dashboard/stats endpoint yet — do not build a dashboard screen against a nonexistent `/admin/dashboard/*` API.
- [ ] Redemption reward catalog (`free-delivery`, `discount-10`, `discount-25`) is hardcoded backend-side — there's no admin CRUD for rewards; don't build one against a nonexistent endpoint.

## 3. Known Backend Integration Notes / Limitations

- **Casing is inconsistent across features.** `Order.status` and `Order.paymentMethod` are lowerCamel/lowercase; `Payment.status`, `Payment.method`, admin campaign `status`/`targetAudience`, and `DeviceToken.platform` are raw uppercase Prisma enum values. Do not assume one casing convention app-wide — see the enum table (§D).
- **No order cancellation endpoint.** The plan describes `POST /orders/:id/cancel`; it was never implemented. Customers cannot self-cancel; only an ADMIN can transition an order to `cancelled`.
- **No SSE tracking endpoint.** `GET /orders/:id/stream` doesn't exist; use polling against `GET /orders/:id/status`.
- **No customer notification history/inbox.** `GET /me/notifications` doesn't exist — history is local-only on the client, matching the plan's own "audit shows local only" note.
- **No admin dashboard/stats endpoints.** `/admin/dashboard/stats` and `/admin/dashboard/revenue` from the plan were never built.
- **Admin login leaks account existence.** `POST /admin/auth/login` returns `403 NOT_ADMIN` (not a generic `401`) for a correct password on a non-admin account — a deliberate deviation from the plan's stated hardening goal; worth revisiting if this matters for the threat model.
- **`PUT /me/addresses/:id` / `DELETE` / `PATCH .../default` leak existence** via `403` vs `404` for another user's address, unlike every other ownership check in the API (which returns `404` uniformly to avoid leaking existence).
- **Cart has no server-computed subtotal/total field.** Only per-line `totalPrice` plus flat `deliveryFee`/`taxRate`; the authoritative order-level total only exists after checkout.
- **CARD/WALLET payments are non-functional by design** (`501 PAYMENT_PROVIDER_NOT_CONFIGURED`) until a real gateway is chosen and integrated — this is expected, not a bug.
- **Loyalty reward catalog and earn rate (1 point / 10 currency units) are hardcoded**, not configurable via any API — a policy default chosen in the absence of a plan specification.
- **Notification campaign scheduler polls every 60s per running API instance** with a DB-guarded atomic claim, so it's safe (no double-send) but not efficient under multiple replicas — see `DEPLOYMENT_RUNBOOK.md` §9 for detail.
- **`GET /menu`'s `limit` has no enforced upper bound** (unlike admin order listing's cap of 100) — a client requesting an extreme `limit` will get an extreme response; not currently guarded.
- **`DELETE /cart`** does not explicitly clear `appliedPromoId` on the cart row even though it deletes all items — functionally harmless (an empty cart's promo has no effect on totals) but worth knowing if you inspect raw DB state.
