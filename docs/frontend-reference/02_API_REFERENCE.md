# 02 — API Reference

Every endpoint that exists in the codebase, grouped by module. Base URL prefix for all endpoints in this
document (except the two explicitly marked "static route" or "unversioned") is `/api/v1`.

## Conventions used below

- **Auth**: `Public` (no token needed), or `Bearer token required` (any authenticated principal — customer, guest, or admin), or `Bearer token required, ADMIN role`, or `Bearer token required, CUSTOMER role` (note: guests are `role=CUSTOMER`, so CUSTOMER-gated routes accept guests too unless the handler explicitly rejects `isGuest`).
- **Headers**: `Authorization: Bearer <accessToken>` on every non-Public route. `Content-Type: application/json` unless noted.
- All list endpoints return a **bare JSON array** — no `{ data, total, page }` wrapper exists anywhere in this backend.
- All money fields are numbers (JS `number`, 2-decimal precision), never strings.
- All dates are ISO-8601 strings.
- All order statuses on the wire are **lowerCamelCase**: `pending | confirmed | preparing | outForDelivery | delivered | cancelled` (DB stores upper-snake; the mapper converts both directions).

## Error envelope (applies to every endpoint)

Every error response — validation, not-found, forbidden, rate-limited, unhandled — is shaped identically by the global `AllExceptionsFilter`:

```json
{
  "statusCode": 400,
  "error": "BadRequest",
  "message": "human readable message, or \"Validation failed\" for DTO errors",
  "code": "MACHINE_READABLE_CODE",
  "details": ["only present for class-validator errors: array of message strings"],
  "timestamp": "2026-07-24T18:00:00.000Z",
  "path": "/api/v1/...",
  "requestId": "uuid, when x-request-id is present or generated"
}
```

Frontend error handling should branch on `code`, never on `message` (message text is not a stable contract).

---

## Auth (`src/modules/auth`)

### `POST /auth/register`
- **Auth**: Public. Throttled: 20 req/60s per IP (route-specific, stricter than the 100/60s global default).
- **Body** (`RegisterDto`):
  ```json
  { "name": "Ahmed Ali", "email": "ahmed@example.com", "password": "SecurePass123", "phone": "+201000000000" }
  ```
- **Validation**: `name` 2-100 chars. `email` valid email, ≤255 chars. `password` 8-72 chars. `phone` optional, ≤30 chars.
- **Response 201** (`AuthResult`):
  ```json
  {
    "user": { "id": "uuid", "name": "Ahmed Ali", "email": "ahmed@example.com", "phone": null, "avatarUrl": null, "role": "CUSTOMER", "isGuest": false, "locale": "en", "createdAt": "2026-07-24T..." },
    "accessToken": "eyJhbGci...",
    "refreshToken": "opaque-base64url-string"
  }
  ```
- **Errors**: `409 EMAIL_ALREADY_EXISTS` (an active, non-deleted account already has this email). `400 VALIDATION_ERROR`.
- **Notes**: role is always forced to `CUSTOMER` server-side; there is no way to self-register as ADMIN.

### `POST /auth/signup`
- Identical in every respect to `POST /auth/register` — same handler, kept as a frontend-compat alias. Pick one; both work forever.

### `POST /auth/login`
- **Auth**: Public. Throttled 20/60s.
- **Body** (`LoginDto`): `{ "email": "...", "password": "..." }`. `password` just needs `1-72` chars here (login doesn't re-enforce the 8-char minimum — that's a registration-only rule).
- **Response 200**: same `AuthResult` shape as register. Works for **any** role, including ADMIN accounts — this is the "single login endpoint" behavior; it does not require `role === CUSTOMER`.
- **Errors**: `401 INVALID_CREDENTIALS` (wrong email or password — deliberately the same message/code for both, to avoid leaking which one was wrong). `423 ACCOUNT_LOCKED` (5 failed attempts in the tracking window → 15-minute lockout, per `ip+email` key; see `06_AUTH_REFERENCE.md`).

### `POST /admin/auth/login`  (canonical admin path)
- **Auth**: Public. Throttled 20/60s.
- **Body**: identical `LoginDto`.
- **Response 200**: identical `AuthResult` shape.
- **Errors**: `401 INVALID_CREDENTIALS`, `403 NOT_ADMIN` (credentials are valid but `user.role !== 'ADMIN'`), `423 ACCOUNT_LOCKED` (separate brute-force bucket, scope `admin-login`, from the customer `login` scope — same email/IP can be locked out of one without the other).

### `POST /auth/admin/login`  (alias)
- Identical handler to `POST /admin/auth/login`. Both exist; either can be used.

### `POST /auth/refresh`
- **Auth**: Public (the refresh token itself is the credential). No route-specific throttle (falls under the global 100/60s).
- **Body** (`RefreshDto`): `{ "refreshToken": "opaque-string" }`.
- **Response 200**: `{ "accessToken": "...", "refreshToken": "..." }` — a **new** refresh token is issued every time (rotation); the old one is immediately invalidated.
- **Errors**: `401 INVALID_REFRESH_TOKEN` (unknown/malformed), `401 REFRESH_TOKEN_EXPIRED`, `401 REFRESH_TOKEN_REUSED` (the presented token was already rotated once before — this is a strong signal of token theft; **every session in that lineage is revoked server-side** when this happens, so the frontend should force a full re-login, not just retry).

### `POST /auth/logout`
- **Auth**: Bearer token required (any role).
- **Body** (`LogoutDto`, all optional): `{ "refreshToken": "opaque-string" }`. If omitted, only the access token's session context is used but **no refresh token is revoked** (silently succeeds — pass the refresh token to actually kill that session).
- **Response**: `204 No Content`.

### `POST /auth/logout-all`
- **Auth**: Bearer token required (any role). No body.
- **Response**: `204 No Content`. Revokes every active refresh token for the calling user (all devices).

### `POST /auth/guest`
- **Auth**: Public.
- **Body** (`GuestDto`, optional): `{ "deviceId": "..." }` — accepted but **currently not persisted anywhere** (dead field, kept for API-contract compatibility).
- **Response 201**: `AuthResult` for a brand-new `User` row with `isGuest: true`, `role: CUSTOMER`, `fullName: "Guest"`, no email/password. A real, usable access+refresh token pair is issued — guest sessions work identically to real accounts for every CUSTOMER-gated endpoint except loyalty (`403 GUEST_NOT_ELIGIBLE`).

---

## Users (`src/modules/users`)

### `GET /users/me`
- **Auth**: Bearer token required (any role).
- **Response 200** (`UserResponseDto`): `{ "id", "name", "email", "phone", "avatarUrl", "role", "isGuest", "locale", "createdAt" }`.
- **Errors**: `404 USER_NOT_FOUND` (soft-deleted or missing — practically unreachable for a valid token).

### `PATCH /users/me`
- **Auth**: Bearer token required (any role).
- **Body** (`UpdateProfileDto`, all optional): `{ "name": "...", "phone": "...", "avatarUrl": "...", "locale": "ar" | "en" }`.
- **Validation**: `name` 2-100 chars if present. `phone` ≤30. `avatarUrl` ≤2048 (plain string, no format check — same pattern as `MenuItem.imageUrl`). `locale` must be exactly `"ar"` or `"en"`.
- **Response 200**: updated `UserResponseDto`.
- **Notes**: fields omitted from the body are set to Prisma `undefined` (i.e. left unchanged) — but a field explicitly sent as `null` is **not supported by the DTO's types** for `name`/`phone`/`avatarUrl` (they're `string | undefined`, not nullable) — sending `null` will fail validation.

---

## Catalog — public (`src/modules/catalog`)

### `GET /categories`
- **Auth**: Public.
- **Response 200**: array of `{ "id", "nameAr", "nameEn", "iconUrl", "displayOrder" }`. Only `isActive: true, deletedAt: null` categories, ordered by `displayOrder` then `createdAt`.

### `GET /categories/:id`
- **Auth**: Public. **Path param**: `id` (UUID).
- **Response 200**: single category object (same shape as above). Note: unlike the list, this does **not** filter on `isActive` — an inactive category is still fetchable by direct id.
- **Errors**: `404 CATEGORY_NOT_FOUND`.

### `GET /menu`
- **Auth**: Public.
- **Query** (`ListMenuItemsDto`): `categoryId` (UUID, optional), `page` (int ≥1, default 1), `limit` (int 1-100, default 20).
- **Response 200**: array of `MenuItemResponseDto` (see `03_DTO_REFERENCE.md`) — full hydrated shape with `variants[]` and `addonGroups[].addons[]`, only `isActive`/`isAvailable` ones. Only items where `isAvailable: true`, `deletedAt: null`, and the parent category is `isActive: true`.

### `GET /menu/search`
- **Auth**: Public.
- **Query** (`SearchMenuDto`): `q` (string, required, non-empty, ≤200 chars).
- **Response 200**: array of `MenuItemResponseDto`, matched case-insensitively against `nameAr` OR `nameEn` (substring match). No pagination on this endpoint.
- **Errors**: `400 SEARCH_QUERY_EMPTY` (only reachable if `q` is present but all-whitespace, since the DTO itself already requires non-empty).

### `GET /menu/items/:id`
- **Auth**: Public. **Path param**: `id` (UUID).
- **Response 200**: single `MenuItemResponseDto`. Note: does **not** filter on `isAvailable` — an out-of-stock item is still fetchable by direct id (frontend should check `isAvailable` client-side before allowing add-to-cart).
- **Errors**: `404 MENU_ITEM_NOT_FOUND`.

### `GET /home/featured`
- **Auth**: Public.
- **Response 200**: `{ "featured": MenuItemResponseDto[], "categories": CategoryResponseDto[] }`. `featured` = up to 10 items where `isPopular: true` (plus the same availability/active filters as `/menu`). `categories` = same as `GET /categories`.

---

## Catalog — admin categories (`src/modules/catalog`, `AdminCategoriesController`)

All routes: **Bearer token required, ADMIN role**. Base path `/admin/categories`.

### `GET /admin/categories`
- **Response 200**: array of `AdminCategoryResponseDto` (adds `isActive` on top of the public shape). Includes **inactive** categories too (only `deletedAt: null` is filtered).

### `POST /admin/categories`
- **Body** (`CategoryDto`): `{ "nameAr": "...", "nameEn": "...", "iconUrl": "...", "displayOrder": 0 }`. `nameAr`/`nameEn` required, ≤100 chars. `iconUrl` optional string ≤2048. `displayOrder` optional int ≥0, defaults to `0`.
- **Response 201**: created `AdminCategoryResponseDto`.

### `PUT /admin/categories/:id`
- **Path param**: `id` (UUID). **Body**: same `CategoryDto`, full replace.
- **Response 200**: updated `AdminCategoryResponseDto`.
- **Errors**: `404 CATEGORY_NOT_FOUND`.

### `DELETE /admin/categories/:id`
- **Path param**: `id` (UUID).
- **Response**: `204 No Content`. Soft delete (`deletedAt` set, `isActive` forced `false`).
- **Errors**: `404 CATEGORY_NOT_FOUND`, `409 CATEGORY_HAS_ITEMS` (blocked while any non-deleted `MenuItem` still references it — the frontend must move/delete those items first).

---

## Catalog — admin menu items (`src/modules/catalog`, `AdminMenuController`)

All routes: **Bearer token required, ADMIN role**. Base path `/admin/menu`.

### `GET /admin/menu`
- **Query** (`AdminListMenuItemsDto`): `categoryId` (UUID, optional), `q` (string, optional, ≤150 chars, matches `nameAr`/`nameEn` substring).
- **Response 200**: array of `AdminMenuItemResponseDto` — like the public shape but every variant/addon regardless of `isActive`/`isAvailable`, plus `displayOrder` and per-row `isActive`/`isAvailable`/`displayOrder`. Includes unavailable items too (no `isAvailable` filter).

### `POST /admin/menu/items`
- **Body** (`MenuItemDto`) — see `03_DTO_REFERENCE.md` for the full nested shape (variants/addonGroups/addons). Minimal example:
  ```json
  {
    "categoryId": "uuid",
    "nameAr": "سندوتش كبدة",
    "nameEn": "Kebda Sandwich",
    "descriptionAr": "...",
    "descriptionEn": "...",
    "basePrice": 45,
    "imageUrl": "http://localhost:3000/uploads/xxx.png"
  }
  ```
- **`imageUrl` is optional and nullable** — omit it entirely or send `null`; a menu item can exist with no image.
- **Response 201**: created `AdminMenuItemResponseDto`.
- **Errors**: `422 INVALID_CATEGORY` (categoryId doesn't reference an existing, non-deleted category).

### `PUT /admin/menu/items/:id`
- **Path param**: `id` (UUID). **Body**: same `MenuItemDto`, full replace semantics: an included `variants`/`addonGroups` array **replaces the entire set** — entries with an `id` are updated, entries without are created, and any existing row not present in the submitted array is **deleted**. Omitting `variants`/`addonGroups` entirely leaves the existing rows untouched.
- **Response 200**: updated `AdminMenuItemResponseDto`.
- **Errors**: `404 MENU_ITEM_NOT_FOUND`, `422 INVALID_CATEGORY`, `422 INVALID_VARIANT_ASSOCIATION` / `INVALID_ADDON_GROUP_ASSOCIATION` / `INVALID_ADDON_ASSOCIATION` (an `id` in the submitted array belongs to a different item/group), `409 MENU_ENTITY_IN_USE` (tried to remove a variant/addon that's still referenced by a live cart item).

### `PATCH /admin/menu/items/:id/availability`
- **Path param**: `id` (UUID). **Body** (`SetAvailabilityDto`): `{ "isAvailable": false }`.
- **Response 200**: updated `AdminMenuItemResponseDto`.
- **Errors**: `404 MENU_ITEM_NOT_FOUND`.

### `DELETE /admin/menu/items/:id`
- **Path param**: `id` (UUID).
- **Response**: `204 No Content`. Soft delete (`deletedAt` set, `isAvailable` forced `false`). Safe even for items referenced by historical orders (order items are immutable snapshots, not live FKs).
- **Errors**: `404 MENU_ITEM_NOT_FOUND`.

---

## Settings (`src/modules/settings`)

### `GET /settings`
- **Auth**: Public.
- **Response 200** (`PublicSettingsResponseDto`): `{ "deliveryFee": 20, "taxRatePercent": 14, "minOrderAmount": 50, "workingHours": { "open": "10:00", "close": "02:00" }, "isMaintenanceMode": false }`.

### `GET /admin/settings`
- **Auth**: Bearer token required, ADMIN role.
- **Response 200** (`AdminSettingsResponseDto`): everything public plus `{ "id", "restaurantName", "phone", "addressText", "currency", "updatedAt" }`.

### `PUT /admin/settings`
- **Auth**: Bearer token required, ADMIN role.
- **Body** (`UpdateSettingsDto`) — **full replace, all fields required**:
  ```json
  {
    "restaurantName": "Kebda Zaman", "phone": "+20100000000", "addressText": "Cairo, Egypt",
    "taxRatePercent": 14, "deliveryFee": 20, "minOrderAmount": 50, "currency": "EGP",
    "workingHours": { "open": "10:00", "close": "02:00" }, "isMaintenanceMode": false
  }
  ```
- **Validation**: `taxRatePercent` 0-100. `deliveryFee`/`minOrderAmount` ≥0. `workingHours.open`/`.close` must match `HH:MM` 24h regex. There is only ever one settings row (`singleton: true`); this always updates it, never creates a second.
- **Response 200**: updated `AdminSettingsResponseDto`.

---

## Cart (`src/modules/cart`)

All routes: **Bearer token required (any role — guests included)**. Base path `/cart`. One persistent cart per user, created lazily on first access (no explicit "create cart" call needed).

### `GET /cart`
- **Response 200** (`CartResponseDto`): `{ "items": CartItemResponseDto[], "appliedPromo": PromoResponseDto | null, "deliveryFee": 20, "taxRate": 14 }`.
- **Notes**: this read is **lenient** — a line whose item/variant/addon has since become unavailable is still returned with `isAvailable: false` and zeroed prices (never silently dropped, so the customer can see and remove it), rather than the whole request failing.

### `POST /cart/items`
- **Body** (`AddCartItemDto`):
  ```json
  { "menuItemId": "uuid", "variantId": "uuid", "addonIds": ["uuid"], "quantity": 2, "specialInstructions": "no onions" }
  ```
- **Validation**: `menuItemId` required UUID. `variantId` optional UUID. `addonIds` optional array of UUID v4. `quantity` int ≥1. `specialInstructions` optional ≤500 chars.
- **Response 200**: updated `CartResponseDto` (whole cart, not just the new line).
- **Errors** (strict pricing validation runs **before** persisting anything): `404 ITEM_UNAVAILABLE` (item deleted/unavailable), `422 INVALID_VARIANT` (bad variant id, or a variant is required but none/an invalid one was given), `422 INVALID_ADDON_SELECTION` (addon doesn't belong to the item, or an addon group's min/max/required rule is violated).

### `PUT /cart/items/:id`
- **Path param**: `id` = CartItem UUID (not menuItemId). **Body** (`UpdateCartItemDto`, all optional — merge-patch semantics): `{ "quantity": 3, "variantId": "uuid" | null, "addonIds": ["uuid"], "specialInstructions": "..." | null }`.
- **Notes**: `variantId: null` explicitly clears the variant; omitting it leaves it unchanged. `addonIds` (if present, including `[]`) **replaces** the full addon selection.
- **Response 200**: updated `CartResponseDto`.
- **Errors**: `404 CART_ITEM_NOT_FOUND` (wrong id, or belongs to a different user's cart), plus the same `422` pricing errors as add.

### `DELETE /cart/items/:id`
- **Path param**: `id` = CartItem UUID.
- **Response 200**: updated `CartResponseDto` (not 204 — deliberately returns the resulting cart).
- **Errors**: `404 CART_ITEM_NOT_FOUND`.

### `POST /cart/apply-promo`
- **Body** (`ApplyPromoDto`): `{ "code": "SAVE10" }` (required, ≤50 chars).
- **Response 200**: updated `CartResponseDto` with `appliedPromo` populated.
- **Errors**: `404 PROMO_NOT_FOUND`, `422 PROMO_INVALID` (inactive / not yet started / usage exhausted), `422 PROMO_EXPIRED`, `422 PROMO_MIN_ORDER` (cart subtotal below the promo's `minOrderAmount`).

### `DELETE /cart/promo`
- **Response 200**: updated `CartResponseDto` with `appliedPromo: null`. No error if no promo was applied.

### `DELETE /cart`
- **Response 200**: updated (now-empty) `CartResponseDto`. Removes every line item but keeps the Cart row and any applied promo reference (promo is **not** auto-cleared by this call).

---

## Promos (`src/modules/promos`)

### `POST /promos/validate`
- **Auth**: Bearer token required (any role). Throttled: 20 req/60s (sensitive-route bucket).
- **Body** (`ValidatePromoDto`): `{ "code": "SAVE10", "subtotal": 100 }`. **`subtotal` is accepted but silently ignored** — the server always prices from the caller's own live cart, never a client-supplied number.
- **Response 200**: `{ "valid": true, "discountType": "PERCENT" | "FIXED", "value": 10, "computedDiscount": 12.5 }`.
- **Errors**: same `404/422` promo error set as `POST /cart/apply-promo`. This endpoint does **not** apply the promo to the cart — it's a pure check (use `/cart/apply-promo` to actually apply it).

### `GET /admin/promos`
- **Auth**: Bearer token required, ADMIN role.
- **Response 200**: array of `AdminPromoResponseDto` (all non-deleted promos, newest first).

### `POST /admin/promos`
- **Auth**: ADMIN.
- **Body** (`PromoDto`):
  ```json
  { "code": "SAVE10", "discountType": "PERCENT", "value": 10, "minOrderAmount": 50, "maxDiscountAmount": 30, "maxUsage": 100, "perUserLimit": 1, "startsAt": "2026-08-01T00:00:00Z", "expiresAt": "2026-09-01T00:00:00Z", "isActive": true }
  ```
- **Validation**: `code` required ≤50 chars (server uppercases + trims it before storing/comparing). `discountType` enum `PERCENT | FIXED`. `value` ≥0. `minOrderAmount`/`maxDiscountAmount` optional ≥0. `maxUsage`/`perUserLimit` optional int ≥1. `startsAt`/`expiresAt` optional ISO date strings.
- **Response 201**: created `AdminPromoResponseDto`.
- **Errors**: `409 PROMO_CODE_EXISTS`.
- **Note**: `perUserLimit` is accepted and stored but **is not currently enforced anywhere** in `evaluatePromo` — only `maxUsage` (global usage count) is actually checked.

### `PUT /admin/promos/:id`
- **Path param**: `id` (UUID). **Body**: same `PromoDto`, full replace.
- **Response 200**: updated `AdminPromoResponseDto`.
- **Errors**: `404 PROMO_NOT_FOUND`, `409 PROMO_CODE_EXISTS` (if changing the code to one already used by another promo).

### `DELETE /admin/promos/:id`
- **Response**: `204 No Content`. Soft delete (`deletedAt` set, `isActive` forced `false`) — takes effect immediately for validation/checkout.
- **Errors**: `404 PROMO_NOT_FOUND`.

---

## Checkout & Orders (`src/modules/orders`)

### `POST /checkout`  (canonical)  /  `POST /orders`  (same handler, alias)
- **Auth**: Bearer token required, **CUSTOMER role** (guests qualify — they are `role=CUSTOMER`). ADMIN accounts get `403` here.
- **Headers**: `Idempotency-Key` (optional, any string). Strongly recommended for real clients — see notes.
- **Body** (`CheckoutDto`):
  ```json
  {
    "deliveryMethod": "DELIVERY",
    "paymentMethod": "CASH",
    "deliveryAddress": { "title": "Home", "street": "123 Main St", "building": "4A", "floor": "2", "apartment": "5", "city": "Cairo" },
    "promoCode": "SAVE10",
    "redeemRewardId": null,
    "notes": "Ring the bell twice"
  }
  ```
- **Validation**: `deliveryMethod` enum `DELIVERY | PICKUP`. `paymentMethod` enum `CASH | CARD | WALLET`. `deliveryAddress` required **only when** `deliveryMethod === 'DELIVERY'` (service-level check, not DTO-level) — its own fields: `title`/`street`/`building`/`city` required, `floor`/`apartment` optional. `promoCode` optional ≤50. `redeemRewardId` optional, one of the fixed loyalty reward ids (`free-delivery` / `discount-10` / `discount-25`, see `08_NOTIFICATION_REFERENCE.md`... actually see the Loyalty section of `02`/`03` — same catalog `POST /me/loyalty/redeem` uses). `notes` optional ≤1000.
- **`promoCode` and `redeemRewardId` are mutually exclusive** — a checkout may use a promo code OR redeem a loyalty reward, never both. Sending both is rejected with `422 PROMO_AND_LOYALTY_MUTUALLY_EXCLUSIVE` **before any cart/pricing validation runs** (checked first, right after the idempotency-key short-circuit).
- **Response 201** (`OrderResponseDto`) — see `03_DTO_REFERENCE.md` for the full shape, including the additive `loyaltyRedemption` field.
- **Errors**: `422 DELIVERY_ADDRESS_REQUIRED`, `409 EMPTY_CART`, `422 BELOW_MIN_ORDER`, `422 PROMO_AND_LOYALTY_MUTUALLY_EXCLUSIVE`, plus every pricing/promo error (`ITEM_UNAVAILABLE`, `INVALID_VARIANT`, `INVALID_ADDON_SELECTION`, `PROMO_*`), and — only when `redeemRewardId` is set — `404 REWARD_NOT_FOUND` (unknown id), `422 INSUFFICIENT_POINTS` (not enough balance), `422 REWARD_NOT_APPLICABLE` (e.g. `free-delivery` on a `PICKUP` order — there's no delivery fee to waive), `403 GUEST_NOT_ELIGIBLE` (guest accounts cannot redeem). The server **fully re-prices and re-validates the entire cart (and any promo/reward) from scratch** at checkout — nothing the client sent earlier is trusted.
- **Loyalty redemption at checkout (atomic — this is the recommended path over the legacy `POST /me/loyalty/redeem`)**: when `redeemRewardId` is set, the reward is evaluated (balance + applicability check) before pricing, its effect (a flat subtotal discount for `discount-10`/`discount-25`, or a delivery-fee waiver for `free-delivery`) is folded into the order's `discount`/`deliveryFee`/`tax`/`totalAmount` exactly like a promo would be, and the **actual point spend happens inside the same database transaction as order creation and cart clearing**. If anything in that transaction fails — a race against another device redeeming concurrently, an order-number collision, any error — the whole transaction rolls back: no points are lost, no order is created, and the cart is untouched. This is a hard guarantee, not best-effort (see `05_ORDER_LIFECYCLE.md`).
- **Idempotency**: if `Idempotency-Key` is sent and a `Payment` row already exists with that key (namespaced per-user server-side), the **same already-created order is returned again** instead of creating a duplicate — safe to retry a checkout call after a timeout/network error using the same key. This includes `loyaltyRedemption`: a retried call reconstructs and returns the exact same redemption info as the original, and never redeems a second time.
- **Side effects**: cart is cleared **only** on success, inside the same DB transaction as order creation (and loyalty redemption, if any) — a failed checkout never touches the cart.

### `GET /orders`
- **Auth**: Bearer token required (any role — note: no `@Roles()` here, unlike checkout).
- **Query** (`ListOrdersDto`): `status` (one of the 6 lowerCamel statuses, optional), `page` (≥1, default 1), `limit` (≥1, default 20; **no upper cap enforced** on this particular endpoint).
- **Response 200**: array of `OrderResponseDto`, scoped to the caller's own orders only, newest first.

### `GET /orders/:id`
- **Path param**: `id` (UUID).
- **Response 200**: single `OrderResponseDto`. Ownership-scoped — a customer cannot fetch another user's order this way (returns 404, not 403).
- **Errors**: `404 ORDER_NOT_FOUND`.

### `GET /orders/:id/status`
- **Path param**: `id` (UUID).
- **Response 200** (`OrderStatusResponseDto`): `{ "status": "preparing", "statusHistory": [{ "status": "pending", "note": null, "changedAt": "..." }, ...], "estimatedDeliveryTime": null }`. This is the endpoint to poll/subscribe for order tracking screens — lighter payload than the full order.
- **Errors**: `404 ORDER_NOT_FOUND`.

---

## Admin Orders (`src/modules/orders`, `AdminOrdersController`)

All routes: **Bearer token required, ADMIN role**. Base path `/admin/orders`. No ownership restriction — any order.

### `GET /admin/orders`
- **Query** (`AdminListOrdersDto`): `status` (optional), `q` (optional, ≤100 chars — free-text match against `orderNumber`, customer `fullName`, customer `email`), `page` (default 1), `limit` (1-100, default 20).
- **Response 200**: array of `OrderResponseDto`, newest first, across **all** users.

### `GET /admin/orders/:id`
- **Path param**: `id` (UUID).
- **Response 200**: single `OrderResponseDto`.
- **Errors**: `404 ORDER_NOT_FOUND`.

### `PATCH /admin/orders/:id/status`
- **Path param**: `id` (UUID). **Body** (`UpdateOrderStatusDto`): `{ "status": "confirmed", "note": "Kitchen confirmed" }`. `status` must be one of the 6 lowerCamel values; `note` optional ≤1000 chars.
- **Response 200**: updated `OrderResponseDto`.
- **Errors**: `404 ORDER_NOT_FOUND`, `422 INVALID_STATUS_TRANSITION` (see the exact allowed-transition table in `05_ORDER_LIFECYCLE.md` — e.g. you cannot go from `PENDING` straight to `DELIVERED`, and `DELIVERED`/`CANCELLED` are terminal).
- **Side effects on transition to `delivered`**: any pending `CASH` payment for the order is auto-settled to `PAID` (best-effort — failure is logged, never fails this request); loyalty points are credited to the customer (skipped for guests). On **every** successful transition, a best-effort FCM push is sent to the customer (see `08_NOTIFICATION_REFERENCE.md`).

---

## Payments (`src/modules/payments`)

### `POST /payments/intent`
- **Auth**: Bearer token required, CUSTOMER role.
- **Body** (`CreateIntentDto`): `{ "orderId": "uuid" }`.
- **Response 200** (`PaymentIntentResponseDto`): `{ "paymentId": "uuid", "status": "PENDING", "providerData": { "instructions": "Pay with cash upon delivery" } }` — **for `CASH` orders only**, this is the only method that actually works.
- **Errors**: `404 ORDER_NOT_FOUND` (wrong id or not owned by caller), `404 PAYMENT_NOT_FOUND` (should not happen — every order gets a Payment row at checkout), `409 PAYMENT_ALREADY_PROCESSED` (payment isn't `PENDING` anymore), and — **for CARD/WALLET orders — always `501 PAYMENT_PROVIDER_NOT_CONFIGURED`.** There is no working gateway; do not build a "pay with card" flow against this today.

### `GET /payments/:id`
- **Auth**: Bearer token required (any role). **Path param**: `id` (UUID).
- **Response 200** (`PaymentResponseDto`): `{ "id", "orderId", "method", "status", "amount", "currency", "provider", "providerRef", "createdAt", "updatedAt" }`.
- **Errors**: `404 PAYMENT_NOT_FOUND` — returned both for a truly missing payment **and** for one that belongs to someone else (owner-or-ADMIN check; non-owner gets 404, not 403, so existence isn't leaked).

### `POST /payments/webhook`
- **Auth**: Public (gateways call this directly — no user token). Throttled 20/60s.
- **Query** (`WebhookQueryDto`): `?provider=<name>` (required) routes to the matching provider.
- **Body**: raw JSON, gateway-defined shape (currently no real gateway is registered — this endpoint is infrastructure only right now; every provider name either resolves to "unknown" or a provider whose signature verification always reports invalid).
- **Response 200**: `{ "received": true }` (even for a no-op/ignored/duplicate event — webhooks should always get 200 once received/parsed to prevent gateway retries).
- **Errors**: `400 UNKNOWN_PAYMENT_PROVIDER`, `400 INVALID_WEBHOOK_SIGNATURE`, `404 PAYMENT_NOT_FOUND`.
- **Frontend relevance**: none directly — this is gateway-to-server only, documented here for completeness.

---

## Devices (`src/modules/devices`)

All routes: **Bearer token required (any role — guests included)**. Base path `/devices`.

### `POST /devices/register`
- **Body** (`RegisterDeviceDto`): `{ "token": "fcm-token-string", "platform": "ANDROID" | "IOS" | "WEB" | "MACOS" | "WINDOWS" }`. `token` required ≤4096 chars.
- **Response 201**: the created/updated `DeviceToken` row (raw Prisma shape — `{ id, userId, token, platform, lastSeenAt, isActive, createdAt, updatedAt }`).
- **Notes**: upsert by unique `token`. Always re-attaches to the **calling** user — if a different account logs in on the same physical device, that device's token silently transfers ownership. Call this on every app start / after login.

### `PUT /devices/token`
- **Body** (`UpdateDeviceTokenDto`): `{ "oldToken": "...", "token": "new-fcm-token", "platform": "ANDROID" }`. `oldToken` optional (if omitted, behaves exactly like `register`). `token`/`platform` required.
- **Response 200**: updated `DeviceToken` row.
- **Errors**: `404 DEVICE_TOKEN_NOT_FOUND` (if `oldToken` was given but doesn't exist, or belongs to a different user).
- **Notes**: call this from your FCM `onTokenRefresh` handler.

### `DELETE /devices/token`
- **Body** (`DeleteDeviceTokenDto`): `{ "token": "..." }`.
- **Response**: `204 No Content`.
- **Errors**: `404 DEVICE_TOKEN_NOT_FOUND`.
- **Notes**: call this on logout for the current device only (does not affect other devices — use `/auth/logout-all` for full session teardown, which is a separate, unrelated concern from device tokens).

---

## Addresses (`src/modules/addresses`)

All routes: **Bearer token required (any role)**. Base path `/me/addresses`.

### `GET /me/addresses`
- **Response 200**: array of `AddressResponseDto`, oldest first.

### `POST /me/addresses`
- **Body** (`AddressDto`): `{ "title": "Home", "street": "123 Main St", "building": "4A", "floor": "2", "apartment": "5", "city": "Cairo", "notes": "Blue gate", "latitude": 30.0444, "longitude": 31.2357, "isDefault": true }`. `title`/`street`/`building`/`city` required; `floor`/`apartment`/`notes` optional; `latitude`/`longitude` optional numbers; `isDefault` optional bool.
- **Response 201**: created `AddressResponseDto`.
- **Notes**: the **first** address a user ever creates is automatically forced `isDefault: true` regardless of what was sent. Setting `isDefault: true` on any address automatically clears it on every other address for that user (enforced in a transaction, not at the DB level).

### `PUT /me/addresses/:id`
- **Path param**: `id` (UUID). **Body**: same `AddressDto`, full replace.
- **Response 200**: updated `AddressResponseDto`.
- **Errors**: `404 ADDRESS_NOT_FOUND`, `403 FORBIDDEN` (address exists but belongs to another user).

### `DELETE /me/addresses/:id`
- **Response**: `204 No Content`.
- **Errors**: `404 ADDRESS_NOT_FOUND`, `403 FORBIDDEN`.
- **Notes**: no protection against deleting the current default — the user can be left with zero addresses or no default; the frontend should handle that state.

### `PATCH /me/addresses/:id/default`
- **Path param**: `id` (UUID). No body.
- **Response 200**: updated `AddressResponseDto` with `isDefault: true` (and every other address for the user flipped to `false`).
- **Errors**: `404 ADDRESS_NOT_FOUND`, `403 FORBIDDEN`.

**Important integration note**: `/me/addresses` is a fully separate feature from checkout. `CheckoutDto.deliveryAddress` does **not** accept an address `id` — the frontend must copy the chosen saved address's fields into the inline `deliveryAddress` object on every checkout call. See `01_PROJECT_OVERVIEW.md` → "What does NOT exist".

---

## Favorites (`src/modules/favorites`)

All routes: **Bearer token required, CUSTOMER role** (guests qualify; ADMIN accounts get 403). Base path `/me/favorites`.

### `GET /me/favorites`
- **Response 200**: array of `MenuItemResponseDto` (full hydrated menu item shape, not just an id), newest-favorited first.

### `POST /me/favorites`
- **Body** (`AddFavoriteDto`): `{ "menuItemId": "uuid" }`.
- **Response 201**: the **full updated favorites list** (array of `MenuItemResponseDto`, same shape as GET) — not just the one new favorite.
- **Errors**: `404 MENU_ITEM_NOT_FOUND`, `409 FAVORITE_ALREADY_EXISTS`.

### `DELETE /me/favorites/:menuItemId`
- **Path param**: `menuItemId` (UUID — note this is the menu item's id, not a favorite-row id).
- **Response**: `204 No Content`.
- **Errors**: `404 FAVORITE_NOT_FOUND`.

---

## Loyalty (`src/modules/loyalty`)

All routes: **Bearer token required, CUSTOMER role**, **plus an explicit guest check** (`403 GUEST_NOT_ELIGIBLE` if `isGuest: true` — this is stricter than the role check alone). Base path `/me/loyalty`.

### `GET /me/loyalty`
- **Response 200** (`LoyaltyAccountResponseDto`): `{ "id", "userId", "pointsBalance", "createdAt", "updatedAt" }`. Account is created lazily (zero balance) on first read if it doesn't exist yet.

### `GET /me/loyalty/transactions`
- **Response 200**: array of `LoyaltyTransactionResponseDto`: `{ "id", "delta", "reason", "orderId", "rewardId", "createdAt" }`, newest first. `reason` is currently always one of the literal strings `"ORDER_EARNED"` or `"REDEMPTION"`. `rewardId` (new field) is which fixed-catalog reward a `REDEMPTION` row corresponds to — `null` for `ORDER_EARNED` rows and for any row that predates this field.

### `POST /me/loyalty/redeem`  — ⚠️ LEGACY / MANUAL redemption path
- **Prefer `POST /checkout` with `CheckoutDto.redeemRewardId` instead** (see above) for any redemption that's meant to pay for an order — that path is atomic (points spent and order created in one DB transaction; a failure anywhere rolls both back). This endpoint redeems **immediately and standalone**, with no link to any order (`orderId` on the resulting ledger row is always `null`) and **no atomicity guarantee with anything the customer does afterward** — a point spent here is spent, regardless of whether the customer completes a purchase. It is kept only for backward compatibility with existing clients; it still fully works and is not deprecated in the sense of being removed, just superseded for the checkout use case.
- **Body** (`RedeemDto`): `{ "rewardId": "free-delivery" | "discount-10" | "discount-25" }` — **this is a small fixed in-code catalog**, not a database table (see `08` note below / `03_DTO_REFERENCE.md`).
- **Response 201**: `{ "account": LoyaltyAccountResponseDto, "redemption": { "rewardId", "rewardName", "pointsCost", "transactionId", "redeemedAt" } }`.
- **Errors**: `404 REWARD_NOT_FOUND` (unknown `rewardId`), `422 INSUFFICIENT_POINTS`.
- **Reward catalog** (hardcoded, ask backend before assuming this changes):
  | `rewardId` | name | pointsCost | effect |
  |---|---|---|---|
  | `free-delivery` | Free Delivery | 100 | waives the delivery fee — only meaningful/accepted on a `DELIVERY` order |
  | `discount-10` | 10 off your next order | 150 | flat 10 currency-unit discount off the subtotal (capped at the subtotal) |
  | `discount-25` | 25 off your next order | 350 | flat 25 currency-unit discount off the subtotal (capped at the subtotal) |
- **Earning**: 1 point per 10 currency units spent (floored), auto-credited when an order transitions to `delivered` (guests never earn). Not triggered by this endpoint — see Admin Orders above.
- **Race-safety**: both this endpoint and the checkout-time path share the same underlying guarded-decrement logic (`LoyaltyService.applyRedemption`) — two concurrent redemptions for the same account can never both succeed and drive the balance negative; the loser gets `422 INSUFFICIENT_POINTS`.

---

## Admin Notifications (`src/modules/notifications`)

All routes: **Bearer token required, ADMIN role**. Base path `/admin/notifications`.

### `POST /admin/notifications/send`
- **Body** (`CampaignDto`):
  ```json
  {
    "campaignName": "Summer Sale", "title": "50% off today!", "body": "Order now and save.",
    "imageUrl": "http://.../uploads/xxx.png", "type": "promotion",
    "targetAudience": "ALL", "destinationRoute": "/promos/summer", "entityId": "promo-id"
  }
  ```
- **Validation**: `campaignName`/`title` required ≤150. `body` required ≤1000. `imageUrl` optional ≤2048. `type` must be one of the 14 literal values in `08_NOTIFICATION_REFERENCE.md`. `targetAudience` optional enum `ALL | CUSTOMERS | GUESTS`, defaults `ALL`. `destinationRoute` optional ≤500. `entityId` optional ≤100.
- **Response 201**: `AdminCampaignResponseDto` — sent **synchronously and immediately** within this request (status will already be `SENT` or `FAILED` by the time the response returns).

### `POST /admin/notifications/schedule`
- **Body**: `CampaignDto` fields **plus** `scheduledAt` (required ISO date string).
- **Response 201**: `AdminCampaignResponseDto` with `status: "SCHEDULED"`. An in-process poller checks every 60 seconds for due campaigns and dispatches them — **there is no way to trigger it early or to cancel an in-flight send**, only to delete it before it fires (see below).

### `GET /admin/notifications/campaigns`
- **Query** (`ListCampaignsDto`): `page` (default 1; fixed page size of 20, not configurable).
- **Response 200**: array of `AdminCampaignResponseDto`, newest first.

### `DELETE /admin/notifications/campaigns/:id`
- **Path param**: `id` (UUID).
- **Response**: `204 No Content`.
- **Errors**: `404 CAMPAIGN_NOT_FOUND`, `409 CAMPAIGN_NOT_DELETABLE` (only `DRAFT`/`SCHEDULED` campaigns can be deleted — a `SENT`/`SENDING`/`FAILED` one is permanent history).

---

## Uploads (`src/modules/uploads`)

See `07_UPLOAD_SYSTEM.md` for the full walkthrough. Summary:

### `POST /admin/uploads/image`
- **Auth**: Bearer token required, ADMIN role.
- **Body**: `multipart/form-data`, one field named `file`.
- **Response 201**: `{ "imageUrl": "http://host:port/uploads/<uuid>.<ext>" }`.
- **Errors**: `400 FILE_REQUIRED`, `400 INVALID_FILE_TYPE` (not jpg/jpeg/png/webp by both extension and MIME type), `413 PayloadTooLargeException` (>5MB by default, `code: "PAYLOAD_TOO_LARGE"`).

---

## Health (`src/modules/health`)

### `GET /health`
- **Auth**: Public. Liveness only — no dependency checks. Returns `{ "status": "ok", "info": {}, "error": {}, "details": {} }` as long as the process is serving requests.

### `GET /health/ready`
- **Auth**: Public. Readiness — includes a real `SELECT 1` against PostgreSQL. Returns `503` with the same Terminus envelope if the DB is unreachable. Use this for orchestrator/load-balancer health checks, not `/health`.
