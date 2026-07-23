# BACKEND_IMPLEMENTATION_PLAN.md
## Kebda Zaman — Production Backend Implementation Plan

**Plan Timestamp:** 2026-07-23
**Status:** PLANNING ONLY — no code, schema, Docker, or packages created by this document.
**Source of Truth:** `PROJECT_CURRENT_STATE_AUDIT.md` (read-only, must not be modified).
**Scope:** Design a production-ready backend that matches the EXISTING Flutter frontend contract without forcing frontend rewrites, deployable from a local Ubuntu VM to a future Ubuntu VPS with minimal environment-specific changes.

> **Reading note on inconsistencies:** Wherever the audit contradicts itself (e.g. `READY` status, endpoint naming, payment enums, currency/region), this plan documents the contradiction explicitly in **Section 16 — Risks & Open Decisions** and, where a canonical choice is needed to proceed, proposes one *without* silently changing the frontend contract. Nothing here alters the frontend.

---

## Table of Contents

1. Architecture
2. Database Design Plan
3. Frontend Model Compatibility
4. API Contract
5. Authentication & Security
6. Cart & Server-Side Pricing
7. Order Architecture
8. Real-Time Order Tracking
9. Firebase & FCM
10. Payment Architecture
11. Docker & Local Development
12. VPS Deployment Readiness
13. Safe Frontend Migration Strategy
14. Implementation Phases
15. Testing Strategy
16. Risks & Open Decisions
17. First Implementation Step

---

## 1. ARCHITECTURE

### 1.1 Stack Confirmation

The audit's "future backend contract" and requirements matrix are consistent with the requested stack. No part of the stack is contradicted by the audit. Confirmed:

- **Runtime:** Node.js (LTS, pin to 20.x or 22.x in Dockerfile).
- **Language:** TypeScript (strict mode).
- **Framework:** NestJS (modular monolith — appropriate for this scale; **no microservices**).
- **DB:** PostgreSQL 16.
- **ORM:** Prisma.
- **API:** REST, versioned under `/api/v1/`.
- **Container:** Docker + Docker Compose.
- **Auth:** JWT access + refresh with rotation.
- **Push:** Firebase Admin SDK (server-only credentials).

### 1.2 Layered Architecture

Classic NestJS layering, one direction of dependency (Controller → Service → Data Access):

- **Controller layer** — HTTP only. Route binding, DTO binding/validation via `ValidationPipe`, guard application, response shaping. No business logic. No direct Prisma access.
- **Service layer** — All business logic, pricing, transaction orchestration, invariants. Pure-ish and unit-testable. Services depend on `PrismaService` and other services, never on `Request`/`Response`.
- **Data-access layer** — A single injectable `PrismaService` (extends `PrismaClient`, wires connect/disconnect into Nest lifecycle). For complex aggregate reads/writes we use thin **repository providers** per module *only where it reduces duplication* (e.g. `OrderRepository`, `CatalogRepository`). We do **not** build a repository abstraction over every table — Prisma is already the data-access abstraction.
- **DTO layer** — Request DTOs (`class-validator` + `class-transformer`) and Response DTOs (explicit serialization classes / mappers). Response DTOs are the **compatibility firewall** that keeps API JSON shaped exactly like the Flutter models regardless of DB column names (see Section 3).

### 1.3 Cross-Cutting Concerns

- **DTO validation:** Global `ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`. Every request body/query/param is a validated DTO. This is the primary SQL-injection and malformed-input defense (combined with Prisma parameterization).
- **Authentication guards:** `JwtAccessGuard` (default global guard via `APP_GUARD`), with a `@Public()` decorator to opt routes out (login, register, refresh, catalog reads, webhook). Refresh endpoint uses a dedicated `JwtRefreshGuard`.
- **Role-based authorization:** `RolesGuard` + `@Roles('ADMIN' | 'CUSTOMER')` decorator. Admin routes require `ADMIN`. Guest-tolerant routes use an `@AllowGuest()` marker (see Section 5).
- **Error handling:** Global `AllExceptionsFilter` producing a single canonical error envelope:
  ```json
  { "statusCode": 400, "error": "BadRequest", "message": "human readable", "code": "PROMO_EXPIRED", "details": {...}, "timestamp": "...", "path": "/api/v1/..." }
  ```
  A stable machine-readable `code` field lets the Flutter `Failure`/`Result` layer branch without string-matching. Nest `HttpException`s map straight through; Prisma known errors (P2002 unique, P2025 not found) map to 409/404.
- **Logging:** Nest `Logger` with a `pino`-based custom logger for JSON structured logs in production, pretty logs in dev. Request-scoped correlation id (interceptor) attached to every log line. **Never log** passwords, tokens, refresh hashes, Firebase credentials, or full auth headers.
- **API versioning:** URI versioning (`app.enableVersioning({ type: URI })`) with global prefix `api` → all routes served under `/api/v1/...`. Matches the audit's stated `/api/v1/` convention.
- **Configuration management:** `@nestjs/config` with a typed, **schema-validated** config (`joi` or `zod`) that fails fast on boot if a required env var is missing/malformed. Config is grouped (`database`, `jwt`, `firebase`, `app`, `security`).
- **Environment variables:** All environment-specific values (DB URL, JWT secrets, CORS origins, Firebase credentials path, public base URL) come from env only. **No IPs, hosts, secrets, or the VM IP are ever hardcoded in source** (satisfies Section 11 constraint).
- **Health checks:** `@nestjs/terminus` at `GET /api/v1/health` (liveness) and `GET /api/v1/health/ready` (readiness — includes a DB ping). Used by Docker healthchecks and future reverse proxy.

### 1.4 Proposed Folder Structure

```text
kebda-zaman-backend/
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts                      # deterministic seed mirroring FakeMenuRepository catalog
├── src/
│   ├── main.ts                      # bootstrap: prefix, versioning, pipes, helmet, cors
│   ├── app.module.ts
│   ├── common/                      # cross-cutting, no feature logic
│   │   ├── decorators/              # @Public, @Roles, @CurrentUser, @AllowGuest
│   │   ├── guards/                  # JwtAccessGuard, JwtRefreshGuard, RolesGuard
│   │   ├── filters/                 # AllExceptionsFilter
│   │   ├── interceptors/            # LoggingInterceptor, correlation id
│   │   ├── pipes/                   # (custom if needed)
│   │   ├── dto/                     # shared paginated/response envelopes
│   │   └── errors/                  # AppError codes catalog
│   ├── config/                      # typed config + validation schema
│   ├── prisma/                      # PrismaService (module)
│   ├── modules/
│   │   ├── auth/                    # controllers, service, strategies, dto
│   │   ├── users/                   # profile, addresses
│   │   ├── catalog/                 # categories, menu items, variants, addon groups/addons, search
│   │   ├── favorites/
│   │   ├── cart/                    # cart + items + pricing calls
│   │   ├── pricing/                 # PricingService (pure, heavily tested)
│   │   ├── promos/                  # validation + admin CRUD
│   │   ├── orders/                  # checkout tx, order read, status history
│   │   ├── payments/                # gateway-agnostic abstraction + webhook
│   │   ├── loyalty/
│   │   ├── devices/                 # FCM device tokens
│   │   ├── notifications/           # Firebase Admin sender + campaigns + scheduler
│   │   ├── settings/                # restaurant settings
│   │   ├── admin/                   # admin-only dashboard aggregation (thin; reuses services)
│   │   └── health/
│   └── shared/                      # mappers (entity → response DTO), enums
├── test/                            # e2e specs
├── docker/                          # (created later, in Phase 0/10 — not now)
├── .env.example                     # committed; real .env is gitignored
├── package.json
└── tsconfig.json
```

**Module boundary rule:** `admin/*` controllers do not re-implement logic — they call the same `CatalogService`, `OrdersService`, `PromosService`, etc. with `ADMIN` authorization. This prevents customer/admin drift.

---

## 2. DATABASE DESIGN PLAN

Entities derived **strictly** from the audit's data models (Section 6), mock-data audit (Section 7), and proposed entity inventory (Section 19). Global conventions:

- **PK:** `id` UUID (v4) unless noted. Order also carries a human `orderNumber` unique string.
- **Timestamps:** `createdAt` + `updatedAt` on every mutable entity. Immutable snapshot rows (order items) carry `createdAt` only.
- **Money:** PostgreSQL `Decimal(10,2)` (Prisma `Decimal`) everywhere. **Never `float`.** Serialized to the frontend as a `double`/number (Flutter models use `double`).
- **Soft delete:** `deletedAt` (nullable) on catalog/promo entities that the admin can "delete" but that may be referenced by historical orders (`Category`, `MenuItem`, `PromoCode`). Orders and order items are **never** hard-deleted. Users get `deletedAt` for account deactivation. Carts are hard-deletable.
- **Enums:** Postgres enums via Prisma.

### Priority legend
- **P0** = required for the core customer purchase loop + admin order ops (MVP).
- **P1** = required soon after MVP (promos, profile/addresses, campaigns).
- **P2** = secondary (loyalty, richer settings).

### 2.1 `User` — **P0**
- **Purpose:** Account identity, auth, role.
- **Fields:** `id` UUID PK; `email` String unique (nullable to allow guest→registered later? — see decision D4); `passwordHash` String (nullable for guest/social); `fullName` String; `phone` String?; `avatarUrl` String?; `role` enum `UserRole {CUSTOMER, ADMIN}` default CUSTOMER; `isGuest` Boolean default false; `locale` enum/String (`ar`|`en`) — supports audit's "persist locale in profile"; `onboardingCompleted` Boolean default false; `createdAt`, `updatedAt`, `deletedAt?`.
- **Unique:** `email` (partial unique index WHERE `deletedAt IS NULL` and `email IS NOT NULL`).
- **Indexes:** `email`, `role`.
- **Relations:** has many `Address`, `Order`, `DeviceToken`, `RefreshToken`, `Favorite`, one `LoyaltyAccount`, one `Cart`.

### 2.2 `RefreshToken` (session) — **P0**
- **Purpose:** Refresh-token rotation + multi-device sessions + logout/revocation.
- **Fields:** `id` UUID PK; `userId` FK→User (cascade delete); `tokenHash` String (SHA-256/argon2 hash of the refresh token — **never plaintext**); `familyId` UUID (rotation lineage for reuse-detection); `userAgent` String?; `ip` String?; `expiresAt` Timestamp; `revokedAt` Timestamp?; `replacedByTokenId` String?; `createdAt`.
- **Indexes:** `userId`, `tokenHash` (unique), `familyId`.
- **Note:** enables "revoke all sessions" and refresh-reuse detection (revoke whole family on replay).

### 2.3 `Address` — **P1**
- **Purpose:** Saved delivery addresses.
- **Fields (from audit 6.1/19):** `id` UUID PK; `userId` FK→User (cascade); `title` String (e.g. Home/Work); `street` String; `building` String; `floor` String?; `apartment` String?; `city` String; `notes` String?; `latitude` Decimal?; `longitude` Decimal? (map placeholder exists in UI — optional now); `isDefault` Boolean default false; `createdAt`, `updatedAt`.
- **Constraint:** at most one `isDefault=true` per user (enforce in service/tx; optional partial unique index).
- **Index:** `userId`.

### 2.4 `Category` — **P0**
- **Fields (audit 19):** `id` UUID PK; `nameAr` String; `nameEn` String; `iconUrl` String?; `displayOrder` Int default 0; `isActive` Boolean default true; `createdAt`, `updatedAt`, `deletedAt?`.
- **Index:** `displayOrder`, `isActive`.
- **Relations:** has many `MenuItem`.

### 2.5 `MenuItem` — **P0**
- **Fields (audit 6.2/19):** `id` UUID PK; `categoryId` FK→Category (restrict delete); `nameAr`; `nameEn`; `descriptionAr` Text; `descriptionEn` Text; `basePrice` Decimal; `imageUrl` String; `isAvailable` Boolean default true; `isPopular` Boolean default false; `displayOrder` Int?; `createdAt`, `updatedAt`, `deletedAt?`.
- **Indexes:** `categoryId`, `isAvailable`, `isPopular`; a **text/trigram index** on `nameAr`/`nameEn` for `GET /menu/search` (pg_trgm) — P1 optimization.
- **Relations:** has many `ItemVariant`, `AddonGroup`; referenced by `OrderItem` (via snapshot, not hard FK — see 2.13).

### 2.6 `ItemVariant` — **P0**
- **Purpose:** Size/variant with a price delta.
- **Fields (audit 6.3):** `id` UUID PK; `menuItemId` FK→MenuItem (cascade); `nameAr`; `nameEn`; `priceDelta` Decimal default 0; `isDefault` Boolean default false; `displayOrder` Int?; `isActive` Boolean default true; `createdAt`, `updatedAt`.
- **Constraint:** at most one `isDefault` per menu item (service-enforced).
- **Index:** `menuItemId`.

### 2.7 `AddonGroup` — **P0**
- **Fields (audit 6.3):** `id` UUID PK; `menuItemId` FK→MenuItem (cascade); `titleAr`; `titleEn`; `isRequired` Boolean default false; `minSelect` Int default 0; `maxSelect` Int default 1; `displayOrder` Int?; `createdAt`, `updatedAt`.
- **Index:** `menuItemId`.
- **Validation invariant (enforced at pricing/checkout):** `0 <= minSelect <= maxSelect`; if `isRequired` then `minSelect >= 1`.

### 2.8 `Addon` — **P0**
- **Fields (audit 6.3):** `id` UUID PK; `addonGroupId` FK→AddonGroup (cascade); `nameAr`; `nameEn`; `price` Decimal default 0; `isAvailable` Boolean default true; `displayOrder` Int?; `createdAt`, `updatedAt`.
- **Index:** `addonGroupId`.

### 2.9 `Cart` — **P0**
- **Purpose:** Server-side persistent cart (one active cart per user).
- **Fields:** `id` UUID PK; `userId` FK→User unique (nullable to allow guest-device carts — see decision D4); `appliedPromoId` FK→PromoCode?; `createdAt`, `updatedAt`.
- **Note:** delivery fee / tax rate are **not** stored on the cart as authoritative values — they are read from `RestaurantSettings` at pricing time. (Frontend `Cart` carries `deliveryFee`/`taxRate`; the API response fills them from settings — see Section 3.) This prevents client-set fee/tax tampering.
- **Relations:** has many `CartItem`.

### 2.10 `CartItem` — **P0**
- **Purpose:** A configured line (item + variant + addons + qty + instructions).
- **Fields:** `id` UUID PK; `cartId` FK→Cart (cascade); `menuItemId` FK→MenuItem (restrict); `selectedVariantId` FK→ItemVariant?; `quantity` Int (>=1); `specialInstructions` String?; `createdAt`, `updatedAt`.
- **Selected addons:** join table `CartItemAddon { id, cartItemId FK (cascade), addonId FK }`.
- **Important:** `unitPrice`/`totalPrice` are **computed server-side on read**, never stored from client (Section 6). They are returned in the response DTO to match the frontend `CartItem` shape.
- **Index:** `cartId`, `menuItemId`.

### 2.11 `Order` — **P0**
- **Fields (audit 6.5/19):** `id` UUID PK; `orderNumber` String unique; `userId` FK→User (restrict); `status` enum `OrderStatus` (see Section 7 for the READY question) — canonical set: `PENDING, CONFIRMED, PREPARING, OUT_FOR_DELIVERY, DELIVERED, CANCELLED`; `subtotal` Decimal; `deliveryFee` Decimal; `tax` Decimal; `discount` Decimal; `totalAmount` Decimal; `deliveryMethod` enum `DeliveryMethod {DELIVERY, PICKUP}` (frontend checkout offers both — audit Flow 4); `paymentMethod` enum `PaymentMethod {CASH, CARD, WALLET}`; `paymentStatus` enum `PaymentStatus {PENDING, PAID, FAILED, REFUNDED}`; `appliedPromoId` FK→PromoCode?; `promoCodeSnapshot` String?; `deliveryAddressJson` JSONB (address **snapshot** — decouples from later edits/deletes of Address); `estimatedDeliveryTime` Timestamp?; `placedAt`/`createdAt`, `updatedAt`; `cancelledAt?`; `cancelReason?`.
- **Indexes:** `userId`, `status`, `orderNumber` (unique), `createdAt` (dashboard/date filtering).
- **Relations:** has many `OrderItem`, `OrderStatusHistory`, one-to-many `Payment`.
- **Never hard-deleted.**

### 2.12 `OrderItem` — **P0**
> The audit does **not** enumerate `OrderItem` fields (documented gap, see Section 16 / D9). Derived from `CartItem` + snapshot requirement.
- **Fields:** `id` UUID PK; `orderId` FK→Order (cascade); `menuItemId` UUID? (soft reference for analytics — not a hard FK so catalog deletes don't orphan history); `quantity` Int; `unitPrice` Decimal (snapshot, server-computed at checkout); `lineTotal` Decimal (snapshot); `specialInstructions` String?; plus **name snapshots** `nameArSnapshot`, `nameEnSnapshot`, `imageUrlSnapshot`; `createdAt`.

### 2.13 `OrderItemCustomization` (snapshot) — **P0**
- **Purpose:** Immutable record of exactly what the customer chose, independent of future catalog edits.
- **Fields:** `id` UUID PK; `orderItemId` FK→OrderItem (cascade); `kind` enum `{VARIANT, ADDON}`; `refId` UUID? (original variant/addon id, soft ref); `nameArSnapshot`; `nameEnSnapshot`; `priceSnapshot` Decimal; `createdAt`.
- **Rationale:** satisfies audit's "Order item customization snapshots" requirement and guarantees historical orders render correctly even after menu/price changes.

### 2.14 `Payment` — **P1 (abstraction P0-ready)**
- **Purpose:** Gateway-agnostic payment record (Section 10).
- **Fields:** `id` UUID PK; `orderId` FK→Order; `method` enum `PaymentMethod`; `status` enum `PaymentStatus {PENDING, PAID, FAILED, REFUNDED}`; `amount` Decimal; `currency` String (see currency decision D1); `provider` String? (e.g. `cod`, `paymob`, later); `providerRef` String? (gateway transaction id); `idempotencyKey` String unique; `rawWebhookJson` JSONB?; `createdAt`, `updatedAt`.
- **Index:** `orderId`, `providerRef`, `idempotencyKey` (unique).

### 2.15 `PromoCode` — **P1**
- **Fields (audit 4/7/17):** `id` UUID PK; `code` String unique (uppercased); `discountType` enum `{PERCENT, FIXED}`; `value` Decimal; `minOrderAmount` Decimal?; `maxDiscountAmount` Decimal?; `maxUsage` Int?; `usageCount` Int default 0; `perUserLimit` Int?; `startsAt` Timestamp?; `expiresAt` Timestamp?; `isActive` Boolean default true; `createdAt`, `updatedAt`, `deletedAt?`.
- **Unique:** `code`.
- **Relation:** optional `PromoRedemption { id, promoId, userId, orderId, createdAt }` for per-user limit enforcement (P1).

### 2.16 `LoyaltyAccount` + `LoyaltyTransaction` — **P2**
> Audit references `LoyaltyAccount` model but does not enumerate fields (gap D9).
- **LoyaltyAccount:** `id` UUID PK; `userId` FK unique; `pointsBalance` Int default 0; `createdAt`, `updatedAt`.
- **LoyaltyTransaction:** `id`; `accountId` FK; `delta` Int; `reason` String; `orderId?`; `createdAt`. (Redeemable rewards catalog can be P2 static/config initially.)

### 2.17 `DeviceToken` — **P0**
- **Purpose:** FCM token registry, multi-device, guest-tolerant.
- **Fields:** `id` UUID PK; `userId` FK→User? (nullable → guest devices, audit requires); `token` String unique; `platform` enum `{ANDROID, IOS, WEB, MACOS, WINDOWS}`; `lastSeenAt` Timestamp; `isActive` Boolean default true; `createdAt`, `updatedAt`.
- **Unique:** `token`. **Index:** `userId`, `isActive`.

### 2.18 `NotificationCampaign` — **P1**
- **Fields (audit 6.6/19):** `id` UUID PK; `campaignName`; `title`; `body`; `imageUrl?`; `type` String (matches the 14 `NotificationType` values as strings); `targetAudience` enum `{ALL, CUSTOMERS, GUESTS, ...}` (start with `ALL`); `destinationRoute?`; `entityId?`; `status` enum `{DRAFT, SCHEDULED, SENDING, SENT, FAILED}`; `isScheduled` Boolean; `scheduledAt?`; `sentAt?`; `totalRecipients` Int default 0; `deliveredCount` Int default 0; `openedCount` Int default 0; `clickRate` Decimal default 0; `createdByUserId` FK→User; `createdAt`, `updatedAt`.
- **Index:** `status`, `scheduledAt`.

### 2.19 `RestaurantSettings` — **P0-lite / P2-full**
- **Purpose:** Single authoritative source for delivery fee, tax rate, min order — **needed at P0 because pricing depends on it.** Full admin editing UI can be P2, but the row must exist and be seedable from Phase 1.
- **Fields (audit 7):** `id` (singleton row, enforce single row); `restaurantName`; `phone`; `addressText`; `taxRatePercent` Decimal (14% per mock); `deliveryFee` Decimal (20 EGP per mock); `minOrderAmount` Decimal (50 EGP per mock); `currency` String (D1); `workingHours` JSONB (e.g. `{open:"10:00", close:"02:00"}`); `isMaintenanceMode` Boolean default false; `updatedAt`.

### 2.20 `Favorite` — **P1**
- **Fields:** `id` UUID PK; `userId` FK; `menuItemId` FK; `createdAt`. **Unique:** (`userId`,`menuItemId`).

### 2.21 `OrderStatusHistory` — **P0**
- **Fields:** `id` UUID PK; `orderId` FK→Order (cascade); `fromStatus` enum?; `toStatus` enum; `changedByUserId` FK→User?; `note?`; `createdAt`. Powers customer tracking timeline + admin audit.

### Entities intentionally NOT created (avoid over-modeling)
- No separate `Session` table beyond `RefreshToken` (it *is* the session store).
- No `Restaurant` table (single-tenant; `RestaurantSettings` singleton suffices).
- No generic `AuditLog` at MVP (status history covers the order-critical case).
- No `DriverLocation`/GPS table at MVP (tracking is status-timeline based — Section 8).

---

## 3. FRONTEND MODEL COMPATIBILITY

Principle: **the DB may use any column names; the Response DTO/mapper must emit JSON keys that match the existing Flutter models exactly.** Below, each row is `Flutter model field → backend entity source → API response key`.

### 3.1 `MenuItem`
| Flutter field | Backend source | Response key | Note |
|---|---|---|---|
| id | MenuItem.id | `id` (String) | UUID stringified — Flutter expects String, DB is UUID → cast to string ✅ |
| categoryId | MenuItem.categoryId | `categoryId` | ✅ |
| nameAr/nameEn | same | `nameAr`,`nameEn` | ✅ |
| descriptionAr/En | same | `descriptionAr`,`descriptionEn` | ✅ |
| basePrice (double) | basePrice (Decimal) | `basePrice` number | Decimal→number serialization must not emit string ⚠ (config Prisma/JSON) |
| imageUrl | same | `imageUrl` | ✅ |
| isAvailable/isPopular | same | booleans | ✅ |
| variants (List<ItemVariant>) | ItemVariant[] | `variants` | nested (below) |
| addonGroups (List<AddonGroup>) | AddonGroup[] | `addonGroups` | nested |

### 3.2 `ItemVariant`
`id, nameAr, nameEn, priceDelta (double), isDefault (bool)` → map 1:1 from `ItemVariant`. ✅ No structural mismatch.

### 3.3 `AddonGroup` / `Addon`
- AddonGroup: `id, titleAr, titleEn, isRequired, minSelect, maxSelect, addons[]` → 1:1. ✅
- Addon: `id, nameAr, nameEn, price(double)` → 1:1. ✅

### 3.4 `Cart` / `CartItem`
- Flutter `Cart`: `items, appliedPromo (PromoCode?), deliveryFee (double), taxRate (double)`.
  - `deliveryFee` and `taxRate` are **filled from `RestaurantSettings`** in the response, not from client. ✅ shape preserved.
- Flutter `CartItem`: `id, menuItem (full MenuItem), selectedVariant (ItemVariant?), selectedAddons (List<Addon>), quantity, specialInstructions?, unitPrice, totalPrice`.
  - ⚠ **Structural note:** `CartItem.menuItem` embeds a **full `MenuItem`** object. The API must return the nested menu item so the existing UI keeps working. Backend stores only `menuItemId` + selections and **hydrates** the nested `MenuItem` in the response DTO.
  - `unitPrice`/`totalPrice` are **server-computed** and returned (never accepted on write). ✅

### 3.5 `Order` / `OrderItem`
- Flutter `Order`: `id, userId, user(User?), items(List<OrderItem>), status(enum), deliveryAddress(Address), paymentMethod(String), subtotal, deliveryFee, tax, discount, totalAmount, createdAt, estimatedDeliveryTime?`.
  - ⚠ **`status` enum casing:** Flutter enum values are lowerCamel `pending, confirmed, preparing, outForDelivery, delivered, cancelled`. DB enum is UPPER_SNAKE. **The mapper MUST translate** `OUT_FOR_DELIVERY → "outForDelivery"` etc. on the way out, and accept the frontend form on the way in. This is a top breakage risk — see D2.
  - ⚠ **`paymentMethod` is a `String` in Flutter but an enum in DB.** Response must emit the string the frontend expects. Confirm exact string values the UI sends (`"Cash on Delivery"`? `"cash"`? `"CASH"`?) during Phase 2/5 — **decision D3**. The mapper adapts; the DB stays enum.
  - ⚠ **`deliveryAddress` is a full `Address` object** in Flutter, but stored as `deliveryAddressJson` snapshot in DB. Mapper rehydrates the snapshot into the Address JSON shape. ✅
  - `user` (User?) — return a trimmed user object (no passwordHash, no tokens). ✅
- Flutter `OrderItem` — **fields not enumerated in the audit (gap D9).** During Phase 5 we must read the actual `order.dart`/`OrderItem` definition (frontend, read-only) before finalizing the response DTO. Plan: mirror `CartItem`'s response shape (nested item snapshot + selections + unitPrice + totalPrice) unless the real model differs.

### 3.6 `User`
Flutter `User`: `id, name, email, phone?, avatarUrl?, isGuest, createdAt?`.
- ⚠ **Field-name mismatch:** Flutter uses `name`; DB proposes `fullName`. **Mapper emits `name`** (from `fullName`). Do not rename the frontend field. (D2)
- `passwordHash`, `role` **never** serialized to the customer app. `role` may be included for the admin app login response.

### 3.7 `Address`
Flutter `Address` (from profile/checkout): `title, street, building, floor?, apartment?, city, isDefault` (+ id, userId). Map 1:1. Confirm exact Flutter field names in Phase 6 (read-only) before finalizing. ✅ likely.

### 3.8 `PromoCode`
Flutter `PromoCode` fields (from cart/offers/admin): includes `code, discountType/percentage, value, minOrderAmount, expiryDate, maxUsage`. ⚠ Confirm exact key names (`expiryDate` vs `expiresAt`; `discountPercentage` vs `discountType`+`value`) against the real model in Phase for promos — **D5**. Mapper adapts DB→frontend keys.

### 3.9 `NotificationCampaign`
Flutter model (audit 6.6) is richly specified → map 1:1 including `clickRate`, `deliveredCount`, `openedCount`. `status`/`type` enum casing must match the Flutter enums (`CampaignStatus`, `NotificationType`). ✅ with casing care.

### 3.10 `AppNotificationPayload`
`id, type(enum), title, body, route?, entityId?, imageUrl?, timestamp?`. This is the **FCM `data` map** the backend sends. The backend's FCM `data` payload keys **must exactly match** what `notification_model.dart` parses (`type`, `route`, `entityId`, `imageUrl`, `id`, `title`, `body`, `timestamp`). Audit forbids altering `AppNotificationPayload` parsing → **backend adapts to it** (Section 9). The 14 `NotificationType` values are fixed and must be sent verbatim as strings.

### 3.11 Compatibility summary of breakage risks
1. Enum casing (Order status, campaign status, notification type) — **highest risk** (D2).
2. `User.name` vs `fullName` (D2).
3. `paymentMethod` string values (D3).
4. Decimal→JSON number (must not serialize as quoted string).
5. Nested hydration (`CartItem.menuItem`, `Order.deliveryAddress`).
6. Unconfirmed exact field names for `OrderItem`, `PromoCode`, `Address`, `LoyaltyAccount` (D9) — resolve by reading the real (read-only) models before implementing each corresponding phase.

**Mitigation:** a dedicated `shared/mappers/*` layer + contract tests that assert response JSON keys/casing against fixtures captured from the frontend models. No frontend change is required for any item above.

---

## 4. API CONTRACT

### 4.1 Canonical naming convention (resolving audit inconsistencies)
The audit mixes several naming styles. Canonical rules for this backend:
- Base: `/api/v1`.
- Plural nouns for collections (`/orders`, `/addresses`, `/menu/items`).
- Customer-scoped "me" resources under `/me/...` **instead of** the audit's mixed `/user/...` and `/auth/me`. We keep **backward-compatible aliases** where the frontend already hardcodes a path (documented per-endpoint), because the audit says do not force frontend rewrites.
- Auth register endpoint: audit uses BOTH `/auth/signup` (screen table) and `/auth/register` (matrix). **Canonical: `POST /api/v1/auth/register`, with `/auth/signup` accepted as an alias** until the frontend `ApiAuthRepository` is written (it can target either). Flagged D6.
- Device endpoints: audit lists `/devices/register` + `/devices/unregister`; the task brief lists `PUT/DELETE /devices/token`. **Canonical:** `POST /devices/register`, `PUT /devices/token`, `DELETE /devices/token`, plus alias `DELETE /devices/unregister`. Flagged D7.
- Promo: audit has `/cart/apply-promo`, `/cart/promo`, `/promos/validate`, `/promos/active`. **Canonical:** `POST /api/v1/promos/validate` (pure validation, no mutation) and `POST /api/v1/cart/apply-promo` (attach to cart). Both supported. Flagged D8.
- Checkout: audit has `/orders/checkout` and `/orders`. **Canonical: `POST /api/v1/orders`** performs the authoritative checkout (create). Alias `POST /api/v1/orders/checkout` supported.

> Error column below is abbreviated; every endpoint additionally can return `401` (bad/expired token), `403` (wrong role), `422/400` (validation), `429` (rate limit), `500`. Guards emit these globally.

### 4.2 Auth
| Method | URL | Auth | Role | Request DTO | Response DTO | Errors |
|---|---|---|---|---|---|---|
| POST | `/auth/register` (alias `/auth/signup`) | Public | — | `{name,email,password,phone?}` | `{user, accessToken, refreshToken}` | 409 email exists |
| POST | `/auth/login` | Public | — | `{email,password}` | `{user, accessToken, refreshToken}` | 401 invalid creds, 423 locked (brute-force) |
| POST | `/auth/admin/login` | Public | — | `{email,password}` | `{user(role=ADMIN), accessToken, refreshToken}` | 401, 403 not admin |
| POST | `/auth/refresh` | Refresh token | — | `{refreshToken}` | `{accessToken, refreshToken}` | 401 invalid/reused (revokes family) |
| POST | `/auth/logout` | Access | any | `{refreshToken?}` | `204` | — |
| POST | `/auth/logout-all` | Access | any | — | `204` | — |
| GET | `/auth/me` (alias `/me/profile`) | Access | any | — | `User` | 401 |
| POST | `/auth/guest` | Public | — | `{deviceId?}` | `{user(isGuest), accessToken, refreshToken}` | — |

### 4.3 Users / Profile
| Method | URL | Auth | Role | Req | Res | Errors |
|---|---|---|---|---|---|---|
| GET | `/me/profile` (alias `/user/profile`) | Access | CUSTOMER/ADMIN | — | `User` | 401 |
| PUT | `/me/profile` (alias `/user/profile`) | Access | any | `{name?,phone?,avatarUrl?,locale?}` | `User` | 401,422 |
| PUT | `/me/locale` | Access | any | `{locale}` | `User` | — |

### 4.4 Addresses
| Method | URL | Auth | Role | Req | Res | Errors |
|---|---|---|---|---|---|---|
| GET | `/me/addresses` (alias `/user/addresses`) | Access | any | — | `Address[]` | 401 |
| POST | `/me/addresses` | Access | any | `AddressDto` | `Address` | 422 |
| PUT | `/me/addresses/:id` | Access | owner | `AddressDto` | `Address` | 403,404 |
| DELETE | `/me/addresses/:id` | Access | owner | — | 204 | 403,404 |
| PATCH | `/me/addresses/:id/default` | Access | owner | — | `Address` | 404 |

### 4.5 Catalog — Categories
| GET | `/categories` | Public | — | — | `Category[]` (active, ordered) | — |
| GET | `/categories/:id` | Public | — | — | `Category` | 404 |

### 4.6 Catalog — Menu Items
| GET | `/menu` | Public | — | `?categoryId&page&limit` | `MenuItem[]` (nested variants/addons) | — |
| GET | `/menu/items/:id` | Public | — | — | `MenuItem` full | 404 |
| GET | `/home/featured` | Public | — | — | `{featured:MenuItem[], categories:Category[]}` | — |

### 4.7 Search
| GET | `/menu/search` | Public | — | `?q=` | `MenuItem[]` | 400 empty q |

### 4.8 Favorites
| GET | `/me/favorites` (alias `/user/favorites`) | Access | CUSTOMER | — | `MenuItem[]` | 401 |
| POST | `/me/favorites` | Access | CUSTOMER | `{menuItemId}` | `MenuItem[]` | 404,409 |
| DELETE | `/me/favorites/:menuItemId` | Access | CUSTOMER | — | 204 | 404 |

### 4.9 Cart
| GET | `/cart` | Access (guest-ok) | any | — | `Cart` (server-priced) | 401 |
| POST | `/cart/items` | Access (guest-ok) | any | `{menuItemId, variantId?, addonIds[], quantity, specialInstructions?}` | `Cart` | 404 item, 422 invalid selection |
| PUT | `/cart/items/:id` | Access | owner | `{quantity?, variantId?, addonIds?, specialInstructions?}` | `Cart` | 404,422 |
| DELETE | `/cart/items/:id` | Access | owner | — | `Cart` | 404 |
| POST | `/cart/apply-promo` | Access | any | `{code}` | `Cart` | 404/422 invalid promo |
| DELETE | `/cart/promo` | Access | any | — | `Cart` | — |
| DELETE | `/cart` | Access | any | — | `Cart` (emptied) | — |

### 4.10 Promo Codes
| POST | `/promos/validate` | Access | any | `{code, subtotal?}` (server ignores client subtotal for final calc) | `{valid, discountType, value, computedDiscount}` | 404,422 expired/min-order |
| GET | `/promos/active` | Public | — | — | `PromoCode[]` (public-safe) | — |

### 4.11 Checkout
| POST | `/orders` (alias `/orders/checkout`) | Access | CUSTOMER | `{addressId | inlineAddress, deliveryMethod, paymentMethod, promoCode?, notes?}` — **no prices** | `Order` | 409 empty cart, 422 unavailable item / invalid promo / below min order, 402 payment (later) |

> The checkout request carries **no monetary fields**. Server recomputes everything (Section 6).

### 4.12 Orders / Tracking
| GET | `/orders` (alias `/user/orders`) | Access | CUSTOMER | `?status&page` | `Order[]` | 401 |
| GET | `/orders/:id` | Access | owner/ADMIN | — | `Order` | 403,404 |
| GET | `/orders/:id/tracking` | Access | owner/ADMIN | — | `{status, statusHistory[], estimatedDeliveryTime}` | 404 |
| GET | `/orders/:id/stream` (SSE) | Access | owner | — | text/event-stream status events | 404 |
| POST | `/orders/:id/cancel` | Access | owner | `{reason?}` | `Order` | 409 not cancellable |

### 4.13 Payments
| POST | `/payments/intent` | Access | CUSTOMER | `{orderId}` | `{paymentId, status, providerData?}` | 404,409 |
| POST | `/payments/webhook` | Public (signature-verified) | — | raw gateway body | 200 | 400 bad signature |
| GET | `/payments/:id` | Access | owner/ADMIN | — | `Payment` | 403,404 |

### 4.14 Loyalty
| GET | `/me/loyalty` (alias `/user/loyalty`) | Access | CUSTOMER | — | `LoyaltyAccount` | 401 |
| POST | `/me/loyalty/redeem` | Access | CUSTOMER | `{rewardId}` | `{account, redemption}` | 422 insufficient points |

### 4.15 Device Tokens
| POST | `/devices/register` | Access (guest-ok) or Public+deviceId | any | `{token, platform}` | `DeviceToken` | 422 |
| PUT | `/devices/token` | Access (guest-ok) | any | `{oldToken?, token, platform}` | `DeviceToken` | 404 |
| DELETE | `/devices/token` (alias `/devices/unregister`) | Access or token-scoped | any | `{token}` | 204 | 404 |

### 4.16 Notifications (customer)
| GET | `/me/notifications` | Access | CUSTOMER | — | `AppNotificationPayload[]` (history) | — | *(P2, optional — audit shows local only)* |

### 4.17 Admin — Dashboard
| GET | `/admin/dashboard/stats` | Access | ADMIN | `?range` | `{salesTotal, ordersCount, activeOrders, topItems[]}` | 403 |
| GET | `/admin/dashboard/revenue` | Access | ADMIN | `?range` | `{series[]}` | 403 |

### 4.18 Admin — Menu Management
| GET | `/admin/menu` | ADMIN | | `?q&categoryId` | `MenuItem[]` (incl. unavailable) |
| POST | `/admin/menu/items` | ADMIN | | `MenuItemDto (+variants+addonGroups)` | `MenuItem` |
| PUT | `/admin/menu/items/:id` | ADMIN | | `MenuItemDto` | `MenuItem` |
| PATCH | `/admin/menu/items/:id/availability` | ADMIN | | `{isAvailable}` | `MenuItem` |
| DELETE | `/admin/menu/items/:id` | ADMIN | | — | 204 (soft delete) |

### 4.19 Admin — Category Management
| GET | `/admin/categories` | ADMIN | | — | `Category[]` |
| POST | `/admin/categories` | ADMIN | | `CategoryDto` | `Category` |
| PUT | `/admin/categories/:id` | ADMIN | | `CategoryDto` | `Category` |
| DELETE | `/admin/categories/:id` | ADMIN | | — | 204 (soft delete; block if items attached or cascade-deactivate) |

### 4.20 Admin — Orders
| GET | `/admin/orders` | ADMIN | | `?status&page&q` | `Order[]` |
| GET | `/admin/orders/:id` | ADMIN | | — | `Order` |
| PATCH | `/admin/orders/:id/status` | ADMIN | | `{status, note?}` | `Order` (validates transition, writes history, triggers FCM) |

### 4.21 Admin — Promotions
| GET | `/admin/promos` | ADMIN | | — | `PromoCode[]` |
| POST | `/admin/promos` | ADMIN | | `PromoDto` | `PromoCode` |
| PUT | `/admin/promos/:id` | ADMIN | | `PromoDto` | `PromoCode` |
| DELETE | `/admin/promos/:id` | ADMIN | | — | 204 (soft delete) |

### 4.22 Admin — Notifications
| POST | `/admin/notifications/send` | ADMIN | | `CampaignDto` | `NotificationCampaign` (status SENDING→SENT) |
| POST | `/admin/notifications/schedule` | ADMIN | | `CampaignDto(+scheduledAt)` | `NotificationCampaign(status SCHEDULED)` |
| GET | `/admin/notifications/campaigns` | ADMIN | | `?page` | `NotificationCampaign[]` |
| DELETE | `/admin/notifications/campaigns/:id` | ADMIN | | — | 204 (draft/scheduled only) |

### 4.23 Admin — Settings
| GET | `/admin/settings` | ADMIN | | — | `RestaurantSettings` |
| PUT | `/admin/settings` | ADMIN | | `SettingsDto` | `RestaurantSettings` |
| GET | `/settings` | Public | — | — | public subset (delivery fee, tax, min order, hours, maintenance) |

---

## 5. AUTHENTICATION & SECURITY

### 5.1 Flows
- **Customer registration** (`POST /auth/register`): validate → check unique email → `argon2id` hash password → create `User(role=CUSTOMER)` + `LoyaltyAccount` → issue access+refresh → persist refresh hash + family. If a guest cart/device exists (via `deviceId`), optionally merge into the new user (D4).
- **Customer login** (`POST /auth/login`): fetch by email → argon2 verify → issue tokens. Constant-time behavior for unknown email vs bad password (same 401 + timing-safe).
- **Admin login** (`POST /auth/admin/login`): same as login but rejects non-`ADMIN` with 403 after successful password check (avoid role leak: return generic 401 on bad creds). Admins are **not** self-registerable — seeded/promoted only.
- **Guest** (`POST /auth/guest`): issues a short-lived token for `isGuest` user so cart/device endpoints work; guest cannot checkout requiring account (decision on guest-checkout = D4).

### 5.2 Tokens
- **Access token:** JWT, ~15 min TTL, claims `{sub, role, isGuest, jti}`. Signed with `JWT_ACCESS_SECRET` (or RS256 keypair — see D10). Stateless; validated by `JwtAccessGuard`.
- **Refresh token:** opaque random (or JWT) ~30 day TTL, **stored hashed** in `RefreshToken`, one row per session/device.
- **Rotation:** every `/auth/refresh` issues a new refresh token, marks old `revokedAt` + `replacedByTokenId`, keeps `familyId`. **Reuse detection:** if a revoked/replaced token is presented, revoke the entire family (all sessions in lineage) → forces re-login. Mitigates token theft.
- **Logout:** revoke the presented refresh token (single device). `logout-all`: revoke all user tokens.

### 5.3 Password handling
- `argon2id` (preferred) or bcrypt(cost≥12). **Never store or log plaintext.** Password policy enforced in DTO (min length, etc.). No password ever returned in any response.

### 5.4 RBAC
- Two roles: `CUSTOMER`, `ADMIN`. Global `JwtAccessGuard` + `RolesGuard`. `@Roles('ADMIN')` on all `/admin/*`. `@Public()` for catalog reads, auth entry points, webhook, health. `@AllowGuest()` for cart/device where guests are permitted.

### 5.5 Token handling per client
- **Flutter mobile:** store access token in memory, refresh token in **`flutter_secure_storage`** (Keychain/Keystep) — *frontend guidance only, not implemented here.* Backend just issues tokens; it does not dictate mobile storage but the contract (JSON tokens in body) supports secure storage.
- **Flutter Web Admin Panel:** the audit (Risk #2) flags web `SharedPreferences`/localStorage as insecure. **Recommended:** deliver the **refresh token as an HttpOnly, Secure, SameSite=Strict cookie** for the admin web origin, while the access token stays in memory. This requires (a) CORS `credentials: true`, (b) exact admin origin allowlist, (c) CSRF protection (double-submit token or SameSite=Strict) on state-changing admin routes. Provide a config flag `AUTH_WEB_COOKIE_MODE` so mobile keeps body-token flow and web uses cookie flow — **no frontend rewrite forced; opt-in.** (D11)

### 5.6 Hardening checklist
- **Rate limiting:** `@nestjs/throttler` global (e.g. 100 req/min/IP) + stricter per-route on `/auth/login`, `/auth/register`, `/promos/validate`, `/payments/webhook`.
- **Brute-force:** track failed logins per email+IP; exponential backoff / temporary lock (423) after N failures. Backed by a small in-memory store now; move to Redis **only if** multi-instance later (not now).
- **CORS:** explicit origin allowlist from env (`CORS_ORIGINS`). No wildcard in production. Mobile apps don't send Origin → allowed via non-browser path; admin web origin explicit.
- **Helmet:** `helmet()` for security headers (CSP relaxed appropriately for an API, HSTS in prod behind TLS).
- **Request validation:** global `ValidationPipe` (whitelist + forbidNonWhitelisted + transform). Payload size limit (`bodyParser` limit) to prevent large-body DoS.
- **SQL injection:** Prisma parameterizes all queries; **no raw string interpolation**. `$queryRaw` only with tagged templates if ever needed.
- **Secret management:** all secrets via env / Docker secrets. `.env` gitignored; `.env.example` committed with placeholders. Firebase service-account JSON mounted as a file/secret, path via env — **never committed, never returned by any endpoint** (satisfies "do not expose Firebase Admin credentials").
- **Transport:** HTTPS terminated at reverse proxy in prod (Section 12). In dev, HTTP on LAN.

---

## 6. CART & SERVER-SIDE PRICING (CRITICAL)

### 6.1 Zero-trust rule
The backend **never** reads any of these from the client: `basePrice`, variant `priceDelta`, addon `price`, `unitPrice`, `subtotal`, `discount`, `tax`, `deliveryFee`, `totalAmount`. The client may send only **references + quantities + a promo code string**. All money is derived from DB rows.

### 6.2 Authoritative pricing algorithm (`PricingService.priceCart(cart, settings, promo?)`)
Pure function over DB-fetched data; returns a fully-computed price breakdown. Steps:

1. **Load settings** (`RestaurantSettings`): `taxRatePercent`, `deliveryFee`, `minOrderAmount`, `currency`, `isMaintenanceMode`.
2. **For each cart item:**
   a. Load `MenuItem` by id; assert `isAvailable && deletedAt == null` → else `ITEM_UNAVAILABLE`.
   b. If `variantId`: load variant, assert it belongs to the item & `isActive` → `variantDelta`; else if the item has variants and one is required/default, apply rules → `INVALID_VARIANT`.
   c. For each `addonId`: assert it belongs to one of the item's addon groups & `isAvailable`. Enforce each group's `isRequired`/`minSelect`/`maxSelect` → `INVALID_ADDON_SELECTION`.
   d. `unitPrice = basePrice + variantDelta + Σ(addon.price)`.
   e. `lineTotal = unitPrice * quantity` (Decimal math, round to 2 dp per line).
3. `subtotal = Σ lineTotal`.
4. **Promo:** if a code is applied, revalidate against DB (active, within `startsAt`/`expiresAt`, `usageCount < maxUsage`, `subtotal >= minOrderAmount`, per-user limit). Compute `discount`:
   - PERCENT: `subtotal * value/100`, capped at `maxDiscountAmount` if set.
   - FIXED: `min(value, subtotal)`.
   - Invalid → `PROMO_INVALID`/`PROMO_EXPIRED`/`PROMO_MIN_ORDER`.
5. `discountedSubtotal = subtotal - discount`.
6. `tax = round(discountedSubtotal * taxRatePercent/100, 2)` — mirrors frontend formula `(subtotal - discount) * taxRate` (audit §14) so totals match the UI.
7. `deliveryFee = (deliveryMethod == PICKUP) ? 0 : settings.deliveryFee`.
8. `totalAmount = discountedSubtotal + tax + deliveryFee`.
9. **Min-order gate:** if `subtotal < minOrderAmount` → `BELOW_MIN_ORDER` (block checkout, allow cart view).
10. Return `{ lines[], subtotal, discount, tax, deliveryFee, totalAmount, currency }`.

> Rounding policy fixed once (round half-up, 2 dp, per-line then sum) and locked by tests so server total == UI total. Any divergence from the frontend's rounding is a **known reconciliation item** to verify against the real `CartNotifier` in Phase 4.

### 6.3 Checkout transaction flow (`OrdersService.checkout`)
Single DB transaction (`prisma.$transaction`, serializable/`READ COMMITTED` w/ row checks):

1. Load user's active cart with items (row-lock relevant catalog rows if using `SELECT ... FOR UPDATE` via raw or optimistic re-check).
2. Assert cart non-empty → `EMPTY_CART`.
3. Re-run **full pricing** (6.2) inside the tx from fresh DB reads (never trust any earlier client/cart-cached price).
4. Re-validate availability of every item/variant/addon **again inside tx** (guards against a menu edit between add-to-cart and checkout).
5. Re-validate + **atomically increment** promo `usageCount` (guarded so it can't exceed `maxUsage`); create `PromoRedemption`.
6. Generate `orderNumber` (6.4).
7. Snapshot the delivery address into `deliveryAddressJson`.
8. Create `Order` + `OrderItem`s + `OrderItemCustomization` snapshots + initial `OrderStatusHistory(PENDING)`.
9. Create `Payment(status=PENDING)` (COD → may go straight to a pending/awaiting-cash state; gateway → intent created, actual PAID set by webhook — Section 10).
10. Clear the cart (delete items) — but only after successful order creation, inside the same tx.
11. Commit. Post-commit side effects (fire order-created FCM, SSE broadcast) run **after** commit, never inside the tx.

**Transaction boundary rule:** everything that must be consistent (stock/availability check, promo decrement, order+items+payment insert, cart clear) is inside one tx; all external I/O (FCM, email) is outside.

---

## 7. ORDER ARCHITECTURE

### 7.1 The `READY` inconsistency (explicit)
- The **customer `Order` model** and audit §15 lifecycle define: `PENDING → CONFIRMED → PREPARING → OUT_FOR_DELIVERY → DELIVERED | CANCELLED` — **no `READY`.**
- The **Admin Order Management screen** (§4, line 215) lists a **`Ready`** tab: *All, Pending, Confirmed, Preparing, **Ready**, Out for Delivery, Delivered, Cancelled.*
- The **notification system** (§12) supports an **`order_ready`** notification type (one of the 14).

**Analysis:** The admin UI and notification layer already anticipate a `READY` state (food prepared / ready for pickup or hand-off to delivery), but the customer `Order` status enum does not include it. If we add `READY` to the DB enum now, the customer app's status parser (which maps the 6 known lower-camel values) would receive an **unknown value** for orders in `READY`, risking a parse/UI break — and the audit forbids silently changing the frontend lifecycle.

**Recommendation: DEFER `READY` as a customer-facing status; DO NOT emit it to the customer app yet.** Concretely:
- Keep the **canonical customer `OrderStatus` enum = the 6 values** the frontend knows.
- Represent "Ready" in the **admin domain without breaking the customer contract** via one of two options (decision **D2a**, recommend Option A):
  - **Option A (recommended, non-breaking):** Do not add `READY` to the customer status enum. Instead the admin "Ready" tab is a **derived/admin-only sub-state**: either (i) treated as a filter over `PREPARING` with a boolean `isReady` flag on the order, or (ii) modeled as an internal `OrderStatus` value that the **response mapper collapses to `preparing`** when serializing to the customer app. Customer app keeps seeing `preparing`; admin sees `Ready`. `order_ready` FCM can still fire (it's a notification type, not an order-status the app must render in the timeline).
  - **Option B (deferred, breaking — requires coordinated frontend update):** Add `READY` to the shared enum only once the frontend team adds the enum case + timeline step. Do **not** do this unilaterally.
- **`order_ready` notification:** keep it — it is already a valid `NotificationType`; sending it does not require the customer order-status enum to contain `READY`.

This preserves the documented frontend lifecycle while honoring the admin UI's existing `Ready` tab.

### 7.2 Order creation
Per Section 6.3. Order is created only from a server-priced cart within a transaction.

### 7.3 Order number generation
Human-friendly, collision-safe, non-guessable-ish: `KZ-{YYMMDD}-{seq}` where `seq` is a daily counter (DB sequence or a `count+1` inside the tx) or a short random base32 suffix to avoid enumeration. Unique constraint on `orderNumber`. Not derived from the UUID.

### 7.4 Snapshots
- **Item/price snapshot:** `OrderItem` stores `unitPrice`, `lineTotal`, name/image snapshots; `OrderItemCustomization` stores variant/addon names + `priceSnapshot`. Historical orders are immune to later catalog/price edits.
- **Address snapshot:** `deliveryAddressJson` copies the chosen address at checkout time.
- **Promo snapshot:** `promoCodeSnapshot` + `discount` recorded on the order.

### 7.5 Status history & admin transitions
- Every status change writes `OrderStatusHistory(fromStatus, toStatus, changedByUserId, note, createdAt)`.
- **Allowed transition map** (server-enforced) — forward transitions + cancellation rules:
  - `PENDING → CONFIRMED | CANCELLED`
  - `CONFIRMED → PREPARING | CANCELLED`
  - `PREPARING → OUT_FOR_DELIVERY | CANCELLED` (+ internal "ready" per 7.1 Option A)
  - `OUT_FOR_DELIVERY → DELIVERED | CANCELLED`
  - `DELIVERED` = terminal; `CANCELLED` = terminal.
  - Invalid transitions → `422 INVALID_STATUS_TRANSITION`.
- Each transition triggers the matching FCM (`order_confirmed`, `order_preparing`, `order_ready`, `order_out_for_delivery`, `order_delivered`, `order_cancelled`).

### 7.6 Customer tracking
`GET /orders/:id/tracking` returns current status + ordered `statusHistory` + `estimatedDeliveryTime` → feeds the existing timeline UI. Optional SSE stream (Section 8) pushes updates live.

---

## 8. REAL-TIME ORDER TRACKING

### 8.1 Comparison
| Approach | Pros | Cons | Fit |
|---|---|---|---|
| **Polling** (`GET /orders/:id/tracking` every N s) | Trivial, stateless, works everywhere, no extra infra, easy migration from the current local-timer simulation | Slight latency + wasted requests | ✅ Great MVP baseline |
| **SSE** (`GET /orders/:id/stream`) | One-way server→client is exactly the tracking use case; simple over HTTP; no new protocol; works through most proxies; low infra | One connection per tracked order; needs proxy buffering off | ✅ Best value-add for MVP |
| **WebSockets** | Bi-directional, lowest latency | Overkill (tracking is one-way), more infra/scaling/auth complexity, sticky-session concerns | ❌ Not justified for MVP |

### 8.2 Recommendation
**MVP = Polling as the guaranteed baseline + optional SSE enhancement.** Ship `GET /orders/:id/tracking` first (drop-in for the current simulated tracker). Add `GET /orders/:id/stream` (SSE) so the timeline updates live when the admin changes status — implemented as an in-process event emitter fan-out (no Redis/broker needed at single-instance scale). If we ever scale to multiple backend instances, revisit with a lightweight pub/sub — **not now.**

### 8.3 Frontend migration without breaking UI
- The current `OrderTrackingScreen` uses local timers. Migration: replace the timer source in `ApiOrderRepository` with (a) a periodic `GET /orders/:id/tracking` poll first (identical data shape → status + timeline), then (b) optionally subscribe to SSE. The **UI widget and its state model stay unchanged**; only the data source behind `ordersNotifierProvider` changes. No route/name changes (audit §22 constraint respected).

---

## 9. FIREBASE & FCM

### 9.1 Server-only Admin SDK
Firebase Admin SDK initialized on the backend using a **service account JSON mounted as a secret** (path via `FIREBASE_SERVICE_ACCOUNT_PATH` or inline `FIREBASE_SERVICE_ACCOUNT_JSON` env). This credential lives **only** on the backend, is never returned by any endpoint, never logged, never committed. The Flutter app keeps using its client `google-services.json`/`firebase_options.dart` (unchanged) to *receive* pushes; the backend is the only sender. Note the project id is `keebda-zaman` (double-e) per audit — config must use that exact id.

### 9.2 Device token endpoints (per Section 4.15)
- `POST /devices/register {token, platform}` — upsert by unique `token`; attach `userId` if authenticated, else guest (nullable user). Update `lastSeenAt`, `isActive=true`.
- `PUT /devices/token {oldToken?, token, platform}` — handle FCM token refresh: move the record from old→new token, keep user association.
- `DELETE /devices/token {token}` (alias `/devices/unregister`) — mark inactive / delete on logout for that device.

### 9.3 Multi-device / guest / cleanup / logout
- **Multiple devices per user:** many `DeviceToken` rows per `userId`. Campaigns fan out to all active tokens.
- **Guest devices:** `userId` nullable; guest tokens still receive broadcast campaigns; on later login/register, re-register attaches them to the user.
- **Token refresh:** `PUT /devices/token` (9.2). The Flutter `syncTokenWithBackend` TODO becomes a call to `POST /devices/register` (audit §11) — the endpoint name matches the TODO.
- **Invalid token cleanup:** when Firebase Admin returns `messaging/registration-token-not-registered` / `invalid-argument` for a token during send, mark it `isActive=false` (or delete). Keeps the registry clean automatically.
- **Logout:** frontend calls `DELETE /devices/token` for the current device so the account stops receiving pushes there.

### 9.4 Admin campaign flow
`Admin Panel → POST /admin/notifications/send → CampaignService → resolve target audience → collect active device tokens → Firebase Admin SDK multicast → FCM → devices`. The FCM message `data` payload **exactly matches `AppNotificationPayload`** keys (`id, type, title, body, route, entityId, imageUrl, timestamp`) so the existing parser + deep-link navigation work untouched (audit forbids changing the parser). We send `data`-only (or `notification`+`data`) messages consistent with how the app currently handles foreground/background.

### 9.5 Immediate vs scheduled + audiences + history
- **Immediate:** `/admin/notifications/send` creates campaign `SENDING`, dispatches, updates `SENT` + `totalRecipients`/`deliveredCount` from multicast response.
- **Scheduled:** `/admin/notifications/schedule` stores `SCHEDULED` + `scheduledAt`.
- **Simplest reliable scheduler (no Redis):** a NestJS **cron worker** (`@nestjs/schedule`, e.g. every 60s) polls `NotificationCampaign WHERE status=SCHEDULED AND scheduledAt <= now()`, atomically flips to `SENDING` (guarded update to prevent double-send), dispatches, marks `SENT`. This is durable across restarts because state lives in Postgres, not in memory. **Redis is NOT added** — the audit explicitly says not to unless scheduling requires it, and DB-backed polling meets the requirement at this scale. (If we ever need per-second precision or multi-instance coordination, revisit with a job queue — deferred.)
- **Target audiences:** start with `ALL`; structure allows `CUSTOMERS`, `GUESTS`, later segment filters. Resolver returns the token set.
- **Campaign history:** `GET /admin/notifications/campaigns` lists past campaigns with metrics (`deliveredCount`, `openedCount`, `clickRate`). `openedCount`/`clickRate` require client open/click reporting (P2 — the app would report opens; until then these stay 0/derived from delivery).

---

## 10. PAYMENT ARCHITECTURE

### 10.1 Gateway-agnostic abstraction (no concrete gateway implemented)
Define a `PaymentProvider` interface; implement only a `CashOnDeliveryProvider` now. A future `SomeGatewayProvider` (Saudi or Egyptian) plugs in without touching orders.

```
interface PaymentProvider {
  createIntent(order, ctx): Promise<PaymentIntentResult>   // returns providerRef + client data (redirect/iframe/token)
  verifyWebhook(headers, rawBody): WebhookVerification      // signature check
  parseWebhook(rawBody): { providerRef, status, amount }
}
```
Registry keyed by `Order.paymentMethod`/provider name. Order system knows only `Payment.status`, never gateway specifics.

### 10.2 Lifecycle
- **Creation:** at checkout a `Payment(status=PENDING, idempotencyKey)` is created.
  - **COD:** stays `PENDING` (collect on delivery); order proceeds through fulfillment; marked `PAID` when delivered (or a COD-collected flag). Order is not blocked on payment.
  - **Card/Wallet (future):** `createIntent` returns provider data; frontend completes payment; final truth comes from the **webhook**, not the client.
- **Pending → Success:** webhook (or COD delivery) sets `PAID`; may auto-advance order (e.g. `PENDING→CONFIRMED`) per policy.
- **Pending → Failure:** webhook sets `FAILED`; order can be cancelled or retried.
- **Webhook verification:** `POST /payments/webhook` is public but **signature-verified** per provider; reject on bad signature (400). Raw body preserved for HMAC.
- **Idempotency:** unique `idempotencyKey` + dedupe on `providerRef`; repeated webhooks/retries do not double-apply. All webhook handling is idempotent.
- **Order/payment relationship:** `Order 1—* Payment` (allows retries). Order fulfillment status is **separate** from `paymentStatus`; a Saudi (or any) gateway can be added later by implementing one `PaymentProvider` + one webhook parser — **no change to the order tables or checkout tx** beyond selecting the provider.

> Currency is a `Payment`/`RestaurantSettings` field (D1). No gateway (Paymob/Fawry/Stripe/Moyasar/PayTabs) is implemented now, per the brief.

---

## 11. DOCKER & LOCAL DEVELOPMENT

> Files are **not created now** — this is the plan for Phase 0/1.

### 11.1 Services (docker-compose)
- `api` — NestJS (multi-stage Dockerfile).
- `db` — `postgres:16`, named volume for persistence.
- **No Redis** (nothing currently justifies it — scheduler is DB-backed, rate-limit/brute-force in-memory at single instance).
- (Optional dev-only) `adminer`/`pgweb` for DB inspection — dev profile only.

### 11.2 Dockerfile strategy
Multi-stage: `deps` (install) → `build` (tsc + `prisma generate`) → `runtime` (slim node, non-root user, only prod deps + built `dist` + prisma client). `CMD` runs migrations deploy then starts (`prisma migrate deploy && node dist/main.js`) or migrations run as a separate step. Healthcheck hits `/api/v1/health`.

### 11.3 compose specifics
- **volumes:** `pgdata:/var/lib/postgresql/data` (DB persistence survives container recreation).
- **networks:** a private bridge network `kz-net`; `api` reaches `db` by service name `db` (not IP).
- **env:** all via `.env` (compose `env_file`), `DATABASE_URL=postgresql://...@db:5432/kebda`. No host IPs in source/compose.
- **healthchecks:** `db` → `pg_isready`; `api` → curl `/api/v1/health/ready`; `api` `depends_on: db: condition: service_healthy`.
- **restart:** `unless-stopped`.

### 11.4 Accessibility matrix (no hardcoded VM IP)
The API binds `0.0.0.0:3000`; **which address clients use is configuration, never source code:**
1. **Flutter app on Windows host (web/desktop) → VM:** reach via the **VM's LAN IP** (e.g. `http://<vm-ip>:3000`) or, if using VirtualBox NAT, a **host-port forward** `localhost:3000`→VM:3000. The Flutter app reads its base URL from a build-time/env config (`--dart-define=API_BASE_URL=...`) — not hardcoded in Dart logic.
2. **Android Emulator on Windows host:** emulator reaches the host loopback via `10.0.2.2`; combined with a host→VM port forward, base URL = `http://10.0.2.2:3000`. (Frontend config value.)
3. **Physical Android/iOS on same LAN:** use the VM's LAN IP `http://<vm-ip>:3000`; ensure VM firewall allows 3000 on LAN. Because the IP may change, the app takes it from config, and we can later put a dev DNS name in `/etc/hosts` or a small mDNS name.
4. **Future Ubuntu VPS:** public domain over HTTPS via reverse proxy (Section 12); base URL = `https://api.kebdazaman.example`.

**Backend contribution to portability:** never hardcode host/IP; bind `0.0.0.0`; take `PORT`, `PUBLIC_BASE_URL`, `CORS_ORIGINS` from env. The changing VM IP is purely a frontend/config concern and a firewall rule — no source edit.

---

## 12. VPS DEPLOYMENT READINESS

Plan only (no deployment now). Moving VM → VPS should be: `git pull` + `docker compose up -d --build` + `prisma migrate deploy` + provide prod `.env`.

- **Git deployment:** repo cloned on VPS; deploy via `git pull` + compose rebuild (or a small deploy script / GitHub Actions SSH later).
- **Docker Compose:** same base compose + a `docker-compose.prod.yml` override (no dev tools, restart policies, resource limits, prod logging).
- **Production env vars:** separate prod `.env` / Docker secrets: strong `JWT_*` secrets, prod `DATABASE_URL`, `CORS_ORIGINS`=admin domain, `FIREBASE_SERVICE_ACCOUNT_*`, `PUBLIC_BASE_URL`.
- **PostgreSQL persistence:** named volume on the VPS; document the volume path; consider a managed/volume-backed disk.
- **Backups:** scheduled `pg_dump` (cron) to a backups volume + off-site copy; documented restore procedure. (P1 of hardening.)
- **Reverse proxy:** **Caddy** (auto-HTTPS, simplest) or Nginx+Certbot in front of `api`. Terminates TLS, proxies to `api:3000`, sets forwarded headers, disables buffering for SSE routes.
- **HTTPS:** automatic certs (Let's Encrypt via Caddy/Certbot). HSTS enabled behind TLS.
- **Domain:** `api.<domain>` A-record → VPS; admin web served from its own origin (CORS allowlist).
- **Firewall:** `ufw` allow 22 (restricted), 80, 443 only; **Postgres 5432 NOT exposed publicly** (only inside docker network). SSH hardened (keys, no root password).
- **Application logs:** JSON logs to stdout → Docker json-file with rotation (or ship to a log service later). Correlation ids retained.
- **Restart policies:** `restart: unless-stopped` for `api` and `db`; healthchecks drive orchestration.
- **Database migrations:** `prisma migrate deploy` on release (never `migrate dev` in prod). Migrations are forward-only, reviewed, and run before/at container start; document rollback = restore from backup + revert migration.

---

## 13. SAFE FRONTEND MIGRATION STRATEGY

Fake repositories **remain in place** and functional throughout. Migration is per-feature, driven by Riverpod DI (`lib/core/di/providers.dart` maps abstractions → implementations). The backend team ships endpoints; the frontend team swaps one provider at a time from `Fake*Repository` to `Api*Repository` behind the **same abstract interface** (audit §8/§21). No big-bang.

Order (mirrors audit §21 + this plan's phases):
1. **Auth** — `FakeAuthRepository → ApiAuthRepository` once `/auth/*` is live and login/register/refresh/me verified.
2. **Catalog** — `FakeMenuRepository → ApiMenuRepository` once `/categories`, `/menu`, `/menu/items/:id`, `/menu/search` verified against the `MenuItem`/`Category` contract.
3. **Cart** — `FakeCartRepository → ApiCartRepository` once `/cart*` returns server-priced cart matching UI totals.
4. **Orders/Checkout** — `FakeOrderRepository → ApiOrderRepository` once `/orders` checkout + tracking verified (server totals == UI totals).
5. **Devices/FCM** — activate `syncTokenWithBackend` → `POST /devices/register`.
6. **Promos / Profile / Addresses / Favorites** — swap respective repos.
7. **Admin** — point admin providers at `/admin/*`.
8. **Loyalty / Settings / Notifications campaigns** — swap last.

**A `Fake*Repository` may be safely deleted ONLY when:** (a) its `Api*Repository` replacement is merged and shipped, (b) the corresponding endpoints pass e2e + contract tests, (c) the app has run against the API in a real environment for that feature, and (d) no screen still references the fake provider. Until all four hold, keep the fake (audit §22 hard constraint). Final removal = audit Phase 7, after 100% API validation.

Feature flag / config: a single `USE_API` (or per-feature flags) can let the app fall back to fakes if an endpoint regresses during rollout — recommended but a frontend concern.

---

## 14. IMPLEMENTATION PHASES

For each: Objective / Modules / Entities / Endpoints / Tests / Definition of Done / Frontend impact.

### Phase 0 — Backend Foundation
- **Objective:** Bootable NestJS app with all cross-cutting infra; no domain yet.
- **Modules:** config, prisma, common (guards/filters/interceptors/pipes), health.
- **Entities:** none.
- **Endpoints:** `GET /api/v1/health`, `/health/ready`.
- **Tests:** app boots; health e2e; config validation fails-fast test.
- **DoD:** `docker compose up` runs api+db; health green; lint/CI green; `.env.example` present.
- **Frontend impact:** none.

### Phase 1 — Database Foundation
- **Objective:** Prisma schema for all P0 entities + migrations + deterministic seed mirroring `FakeMenuRepository` (6 categories, 10 items w/ variants+addons) and a seeded admin + `RestaurantSettings` (fee 20, tax 14%, min 50).
- **Modules:** prisma extended.
- **Entities:** User, RefreshToken, Category, MenuItem, ItemVariant, AddonGroup, Addon, Cart, CartItem, CartItemAddon, Order, OrderItem, OrderItemCustomization, OrderStatusHistory, Payment, DeviceToken, RestaurantSettings (+ P1 stubs where cheap).
- **Endpoints:** none new.
- **Tests:** migration applies clean; seed idempotent; schema constraint tests (unique email, enum values).
- **DoD:** migrate + seed reproducible from empty DB; ER matches Section 2.
- **Frontend impact:** none.

### Phase 2 — Authentication
- **Objective:** Full JWT access+refresh with rotation, RBAC, guest.
- **Modules:** auth, users (profile/me).
- **Entities:** User, RefreshToken.
- **Endpoints:** `/auth/register|login|admin/login|refresh|logout|logout-all|me|guest`, `/me/profile`.
- **Tests:** unit (hashing, token issue/rotate/reuse-detection), e2e (register→login→refresh→logout), authz (admin vs customer), brute-force lock.
- **DoD:** rotation + reuse-revocation proven; no secret leakage; passwords argon2.
- **Frontend impact:** `FakeAuthRepository → ApiAuthRepository` (migration step 1). No UI change (contract-mapped `User.name`).

### Phase 3 — Catalog
- **Objective:** Read APIs for categories/menu/item/search + admin CRUD + availability toggle.
- **Modules:** catalog, favorites (P1), admin(catalog).
- **Entities:** Category, MenuItem, ItemVariant, AddonGroup, Addon, Favorite.
- **Endpoints:** `/categories*`, `/menu*`, `/home/featured`, `/menu/search`, `/admin/menu*`, `/admin/categories*`.
- **Tests:** contract tests (JSON shape == `MenuItem`/`Category` Flutter models, nested variants/addons), admin CRUD e2e, soft-delete behavior.
- **DoD:** seeded catalog served identically to fake catalog shape.
- **Frontend impact:** `FakeMenuRepository → ApiMenuRepository`.

### Phase 4 — Cart & Pricing
- **Objective:** Server-side persistent cart + authoritative pricing.
- **Modules:** cart, pricing, promos(validate), settings(read).
- **Entities:** Cart, CartItem, CartItemAddon, PromoCode, RestaurantSettings.
- **Endpoints:** `/cart*`, `/promos/validate`, `/settings`.
- **Tests:** **heavy pricing unit tests** (base+variant+addons, group min/max, promo percent/fixed/cap, tax, delivery vs pickup, min-order gate, rounding == UI), cart e2e.
- **DoD:** server totals reconcile with frontend formula on fixtures; no client price trusted.
- **Frontend impact:** `FakeCartRepository → ApiCartRepository`.

### Phase 5 — Orders
- **Objective:** Transactional checkout + order read + tracking + status history + admin transitions.
- **Modules:** orders, admin(orders).
- **Entities:** Order, OrderItem, OrderItemCustomization, OrderStatusHistory (+ Payment PENDING).
- **Endpoints:** `POST /orders`, `/orders`, `/orders/:id`, `/orders/:id/tracking`, `/orders/:id/cancel`, `/admin/orders*`, `PATCH /admin/orders/:id/status`.
- **Tests:** **checkout transaction tests** (atomicity, empty cart, unavailable-mid-checkout, promo decrement race), status-transition tests, snapshot integrity (catalog edit after order), tracking, enum-casing mapper tests.
- **DoD:** order totals == pricing service; snapshots immutable; invalid transitions blocked; `READY` handled per §7.1 without breaking customer enum.
- **Frontend impact:** `FakeOrderRepository → ApiOrderRepository`; tracking source swapped (poll first).

### Phase 6 — Device Tokens & FCM
- **Objective:** Device registry + real push on order events.
- **Modules:** devices, notifications(sender).
- **Entities:** DeviceToken.
- **Endpoints:** `/devices/register`, `/devices/token` (PUT/DELETE).
- **Tests:** device upsert/refresh/cleanup unit, FCM sender mocked (payload keys == `AppNotificationPayload`), invalid-token cleanup, order-event → push integration (mocked Admin SDK).
- **DoD:** order status changes emit correctly-shaped FCM; guest+multi-device supported; credentials server-only.
- **Frontend impact:** activate `syncTokenWithBackend → POST /devices/register`.

### Phase 7 — Admin APIs
- **Objective:** Dashboard, promos CRUD, settings, notification campaigns + scheduler.
- **Modules:** admin(dashboard), promos(admin), settings(admin), notifications(campaigns+cron).
- **Entities:** PromoCode, PromoRedemption, RestaurantSettings, NotificationCampaign.
- **Endpoints:** `/admin/dashboard/*`, `/admin/promos*`, `/admin/settings*`, `/admin/notifications/*`.
- **Tests:** authz (ADMIN only), campaign send/schedule (cron picks scheduled, no double-send), dashboard aggregation correctness.
- **DoD:** admin panel can fully operate against API; scheduler durable across restart; no Redis.
- **Frontend impact:** admin providers → `/admin/*`; offers/settings/notifications repos swapped.

### Phase 8 — Payments
- **Objective:** Gateway-agnostic abstraction + COD live + webhook skeleton.
- **Modules:** payments.
- **Entities:** Payment.
- **Endpoints:** `/payments/intent`, `/payments/webhook`, `/payments/:id`.
- **Tests:** COD lifecycle, webhook idempotency + signature stub, order/payment relationship.
- **DoD:** COD end-to-end; abstraction ready for a real gateway with zero order-table change.
- **Frontend impact:** `FakePaymentService` replaced for COD; card/wallet remain placeholder until a gateway is chosen.

### Phase 9 — Loyalty & Secondary
- **Objective:** Loyalty account/points, favorites (if not in P3), richer settings, notification metrics.
- **Modules:** loyalty.
- **Entities:** LoyaltyAccount, LoyaltyTransaction.
- **Endpoints:** `/me/loyalty`, `/me/loyalty/redeem`.
- **Tests:** point accrual/redemption, insufficient-points.
- **DoD:** loyalty screen served from API.
- **Frontend impact:** `FakeLoyaltyRepository → ApiLoyaltyRepository`, remaining fakes swapped.

### Phase 10 — Production Hardening
- **Objective:** VPS readiness (Section 12).
- **Work:** reverse proxy + HTTPS, prod compose override, backups, log rotation, rate-limit tuning, security review, load smoke test, migration/rollback runbook.
- **Tests:** security/e2e regression suite green; backup/restore drill.
- **DoD:** deployable to Ubuntu VPS via documented steps; audit §20 risks all mitigated.
- **Frontend impact:** point production app at prod base URL; **delete fake repositories** per §13 exit criteria.

---

## 15. TESTING STRATEGY

- **Unit tests:** services in isolation — **`PricingService` and `OrdersService.checkout` get the deepest coverage** (all pricing branches, group min/max, promo types & caps, rounding, tax, delivery/pickup, min-order; checkout atomicity & validation). Auth token logic (rotation, reuse detection, hashing).
- **Integration tests:** service + real Prisma against a disposable Postgres (Testcontainers or a dedicated test DB) — repository/tx behavior, constraints, cascade/soft-delete.
- **API e2e tests:** full HTTP through Nest (`supertest`) per module: auth flows, catalog contract, cart, checkout, admin.
- **Database tests:** migrations apply/rollback cleanly; seed idempotent; unique/constraint enforcement; snapshot immutability after catalog edits.
- **Authentication tests:** register/login/refresh/rotation/reuse-revocation/logout/logout-all; brute-force lockout.
- **Authorization tests:** customer cannot hit `/admin/*` (403); users cannot read others' orders/addresses; guest limits.
- **Pricing tests (priority):** exhaustive table-driven cases; property-based fuzz on quantities/addon combos; **server total == frontend formula** on shared fixtures.
- **Checkout transaction tests (priority):** empty cart, item made unavailable mid-checkout, promo exhausted concurrently (race → no over-usage), rollback on failure leaves cart intact and no orphan order.
- **Order lifecycle tests:** valid/invalid transitions, history writes, `READY` handling doesn't leak an unknown enum to the customer contract.
- **FCM tests:** Admin SDK mocked — payload key/shape assertions (== `AppNotificationPayload`), multicast fan-out, invalid-token cleanup, campaign scheduler (scheduled → sent, no double-send), guest/multi-device.
- **Contract/mapper tests:** every response DTO asserted against fixtures capturing exact Flutter JSON keys + enum casing (guards the Section 3 breakage risks).
- **CI gate:** lint + typecheck + unit + integration + e2e must pass; coverage thresholds highest on `pricing` and `orders`.

---

## 16. RISKS & OPEN DECISIONS

### BLOCKING (must be decided before or during the phase noted; do NOT block Phase 0 foundation on any of these)
- **D1 — Currency / region contradiction.** Mock data is clearly **Egyptian** (EGP, 14% tax, Vodafone/Orange wallets, Arabic "كبدة"), but the payment brief says a **Saudi** gateway will be integrated later. Decide the operating currency (EGP vs SAR) and tax model. *Blocks:* pricing display correctness & payment (Phases 4/8). Foundation unaffected. **Recommendation:** default `currency=EGP` per all existing data until product says otherwise.
- **D2 — Enum casing + `User.name` mapping.** Frontend uses lowerCamel order statuses and `name` (not `fullName`). The mapper must translate both directions. *Blocks:* Phases 2 & 5 correctness. **Recommendation:** implement the mapper + contract tests; never change frontend.
- **D2a — `READY` status.** Admin UI + `order_ready` notification imply READY, but customer `Order` enum omits it. **Recommendation (Section 7.1 Option A):** do NOT add READY to the customer-facing enum now; model it admin-side and collapse to `preparing` in customer responses; keep `order_ready` FCM. Revisit only with coordinated frontend change. *Blocks:* Phase 5 admin board semantics.
- **D3 — `paymentMethod` string values.** Frontend `Order.paymentMethod` is a free `String`; exact values the UI sends/expects (`"CASH"` vs `"Cash on Delivery"` vs `"cod"`) must be read from the real frontend before Phase 5. *Blocks:* Phase 5. **Action:** inspect (read-only) the real checkout/order model.
- **D4 — Guest & cart ownership / guest checkout.** Does a guest (`isGuest`) get a server cart keyed by device, and can guests place orders, or is account required at checkout? Affects `Cart.userId` nullability + checkout guard. *Blocks:* Phases 4/5. **Recommendation:** allow guest cart by device; require lightweight account (or capture phone) at checkout — confirm with product.
- **D9 — Un-enumerated frontend models.** `OrderItem`, `PromoCode`, `Address`, `LoyaltyAccount` field lists are **not fully specified in the audit.** Their exact keys must be read (read-only) from the real Flutter models before implementing the matching response DTO. *Blocks:* the specific phase for each (5, 4/7, 6-profile, 9).

### NON-BLOCKING (sensible defaults chosen; revisit if needed)
- **D5 — PromoCode field naming** (`expiryDate` vs `expiresAt`, `discountPercentage` vs `discountType`+`value`): mapper adapts; confirm at Phase 7.
- **D6 — register vs signup path:** support both (`/auth/register` canonical, `/auth/signup` alias).
- **D7 — device endpoint shape:** support both audit (`/devices/register`+`/unregister`) and brief (`PUT/DELETE /devices/token`).
- **D8 — promo endpoint shape:** support `/promos/validate` + `/cart/apply-promo`.
- **D10 — JWT signing:** HS256 (shared secret) for MVP; RS256 keypair optional later for multi-service. Default HS256.
- **D11 — Admin web token storage:** HttpOnly-cookie mode for admin web (opt-in via config) vs body tokens for mobile. Recommend cookie mode for web, but ship body-token first, add cookie mode in Phase 10/admin hardening.
- **D12 — Firebase project id spelling** (`keebda-zaman`): use exactly as configured; not a code decision, just config accuracy.
- **D13 — SSE vs polling rollout:** ship polling first, add SSE — non-blocking.
- **D14 — Notification `openedCount`/`clickRate`:** require client open reporting; default to delivery-based metrics until the app reports opens (P2).

---

## 17. FIRST IMPLEMENTATION STEP (proposed — DO NOT EXECUTE)

**Execute Phase 0, Step 1 only:** initialize the NestJS project skeleton with TypeScript strict mode, the global cross-cutting infrastructure (typed+validated config module, `PrismaService` module wired to lifecycle, global `ValidationPipe`, `AllExceptionsFilter` with the canonical error envelope, structured logger + correlation-id interceptor, URI versioning under `/api/v1`, `helmet` + CORS-from-env), and a working **`GET /api/v1/health` + `/health/ready`** endpoint — with a first-pass `docker-compose.yml` (api + postgres:16, named volume, healthchecks, env from `.env`) and a multi-stage `Dockerfile`, plus a committed `.env.example`.

**Definition of done for that first step:** `docker compose up` brings up `api` + `db`; `GET /api/v1/health/ready` returns green (including a DB ping); config fails fast on a missing required env var; CI (lint + typecheck + boot test) passes. **No domain entities, no auth, no business endpoints yet** — that begins in Phase 1/2 after this foundation is reviewed.

This step is intentionally scoped to be reversible and to touch **only** the new backend project directory — it does not modify `PROJECT_CURRENT_STATE_AUDIT.md` or any frontend code.

---

*End of BACKEND_IMPLEMENTATION_PLAN.md*
