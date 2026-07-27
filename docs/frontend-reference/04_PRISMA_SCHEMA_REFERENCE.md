# 04 — Prisma Schema Reference

Generated from `prisma/schema.prisma` directly (PostgreSQL, `prisma-client-js`). This is the **database** shape —
API responses are field-picked/renamed subsets of this (see `03_DTO_REFERENCE.md`); do not assume an API
response mirrors a model 1:1 unless stated.

## Enums

| Enum | Values |
|---|---|
| `UserRole` | `CUSTOMER`, `ADMIN` |
| `OrderStatus` | `PENDING`, `CONFIRMED`, `PREPARING`, `OUT_FOR_DELIVERY`, `DELIVERED`, `CANCELLED` |
| `DeliveryMethod` | `DELIVERY`, `PICKUP` |
| `PaymentMethod` | `CASH`, `CARD`, `WALLET` |
| `PaymentStatus` | `PENDING`, `PAID`, `FAILED`, `REFUNDED` |
| `DiscountType` | `PERCENT`, `FIXED` |
| `OrderItemCustomizationKind` | `VARIANT`, `ADDON` |
| `DevicePlatform` | `ANDROID`, `IOS`, `WEB`, `MACOS`, `WINDOWS` |
| `CampaignTargetAudience` | `ALL`, `CUSTOMERS`, `GUESTS` |
| `CampaignStatus` | `DRAFT`, `SCHEDULED`, `SENDING`, `SENT`, `FAILED` |

No `READY` order status exists. No `NotificationCampaign.type` enum exists at the DB level — it's a plain
`String` column, validated only at the DTO layer against the 14-value list in `08_NOTIFICATION_REFERENCE.md`.

---

## `User`
Account identity for **both** customers and admins — one table, `role` distinguishes them.

| Column | Type | Nullable | Notes |
|---|---|---|---|
| id | Uuid | no | PK |
| email | String | **yes** | nullable to allow guests. Uniqueness among *active* accounts enforced by a **raw-SQL partial unique index** (`WHERE deletedAt IS NULL AND email IS NOT NULL`) — not expressible in Prisma's schema DSL, so it will not show up as a `@@unique` here but is real and enforced by the DB |
| passwordHash | String | **yes** | null for guests, and for any admin-seeded account created without a password |
| fullName | String | no | |
| phone | String | **yes** | |
| avatarUrl | String | **yes** | |
| role | UserRole | no | default `CUSTOMER` |
| isGuest | Boolean | no | default `false` |
| locale | String | no | default `"en"` |
| onboardingCompleted | Boolean | no | default `false` |
| createdAt / updatedAt | DateTime | no | |
| deletedAt | DateTime | **yes** | soft-delete marker; most queries filter `deletedAt: null` |

**Indexes**: `@@index([email])`, `@@index([role])`.
**Relations**: `refreshTokens[]`, `orders[]`, `deviceTokens[]`, `cart?` (one-to-one, `Cart.userId` unique), `statusChanges[]` (as the admin who changed an order's status), `createdCampaigns[]`, `addresses[]`, `favorites[]`, `loyaltyAccount?` (one-to-one).

---

## `RefreshToken`
| Column | Type | Nullable | Notes |
|---|---|---|---|
| id | Uuid | no | PK |
| userId | Uuid | no | FK → `User.id`, **Cascade** on delete |
| tokenHash | String | no | **unique** — SHA-256 of the raw opaque token; the raw token is never stored |
| familyId | Uuid | no | groups a rotation lineage; reuse of a revoked token in a family revokes the whole family |
| userAgent | String | yes | |
| ip | String | yes | |
| expiresAt | DateTime | no | |
| revokedAt | DateTime | yes | |
| replacedByTokenId | String | yes | not an FK (plain string) |
| createdAt | DateTime | no | |

**Indexes**: `@@index([userId])`, `@@index([familyId])`.

---

## Catalog

### `Category`
| Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| nameAr, nameEn | String | no |
| iconUrl | String | **yes** |
| displayOrder | Int | no, default `0` |
| isActive | Boolean | no, default `true` |
| createdAt/updatedAt | DateTime | no |
| deletedAt | DateTime | **yes** |

**Indexes**: `@@index([displayOrder])`, `@@index([isActive])`.
**Relations**: `menuItems[]`.
**Cascade note**: deleting a category is **blocked at the service layer** (not DB `onDelete`) while it still has non-deleted menu items — see `catalog.service.ts`. The FK itself is `onDelete: Restrict` on `MenuItem.category`.

### `MenuItem`
| Column | Type | Nullable | Notes |
|---|---|---|---|
| id | Uuid | no | |
| categoryId | Uuid | no | FK → `Category.id`, `onDelete: Restrict` |
| nameAr, nameEn | String | no | |
| descriptionAr, descriptionEn | String (`@db.Text`) | no | |
| basePrice | Decimal(10,2) | no | |
| imageUrl | String | **yes** | nullable — a menu item can have no image |
| isAvailable | Boolean | no, default `true` | |
| isPopular | Boolean | no, default `false` | |
| displayOrder | Int | **yes** | |
| createdAt/updatedAt | DateTime | no | |
| deletedAt | DateTime | **yes** | |

**Indexes**: `@@index([categoryId])`, `@@index([isAvailable])`, `@@index([isPopular])`.
**Relations**: `category`, `variants[]`, `addonGroups[]`, `cartItems[]`, `favorites[]`.
**Important**: `MenuItem` is referenced by `OrderItem.menuItemId` only as a **soft reference (plain UUID, not an FK)** — deleting a menu item never orphans historical order data, because orders store an immutable name/image/price snapshot instead of a live join.

### `ItemVariant`
| Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| menuItemId | Uuid | no — FK → `MenuItem.id`, **Cascade** on delete |
| nameAr, nameEn | String | no |
| priceDelta | Decimal(10,2) | no, default `0` (can be negative) |
| isDefault | Boolean | no, default `false` |
| displayOrder | Int | **yes** |
| isActive | Boolean | no, default `true` |
| createdAt/updatedAt | DateTime | no |

**Indexes**: `@@index([menuItemId])`. **Relations**: `menuItem`, `cartItems[]`.

### `AddonGroup`
| Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| menuItemId | Uuid | no — FK, **Cascade** |
| titleAr, titleEn | String | no |
| isRequired | Boolean | no, default `false` |
| minSelect | Int | no, default `0` |
| maxSelect | Int | no, default `1` |
| displayOrder | Int | **yes** |
| createdAt/updatedAt | DateTime | no |

**Indexes**: `@@index([menuItemId])`. **Relations**: `menuItem`, `addons[]`.
`minSelect`/`maxSelect` invariants are enforced in `PricingService`, not by any DB constraint.

### `Addon`
| Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| addonGroupId | Uuid | no — FK, **Cascade** |
| nameAr, nameEn | String | no |
| price | Decimal(10,2) | no, default `0` |
| isAvailable | Boolean | no, default `true` |
| displayOrder | Int | **yes** |
| createdAt/updatedAt | DateTime | no |

**Indexes**: `@@index([addonGroupId])`. **Relations**: `addonGroup`, `cartItemAddons[]`.

---

## `PromoCode`
Minimal stub — see the schema's own top-of-file comment: only exists because `Cart`/`Order` hold hard FKs to it.

| Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| code | String | no, **unique** |
| discountType | DiscountType | no |
| value | Decimal(10,2) | no |
| minOrderAmount | Decimal(10,2) | **yes** |
| maxDiscountAmount | Decimal(10,2) | **yes** |
| maxUsage | Int | **yes** |
| usageCount | Int | no, default `0` |
| perUserLimit | Int | **yes** — stored, **not enforced** by any service code |
| startsAt | DateTime | **yes** |
| expiresAt | DateTime | **yes** |
| isActive | Boolean | no, default `true` |
| createdAt/updatedAt | DateTime | no |
| deletedAt | DateTime | **yes** |

**Relations**: `carts[]`, `orders[]`. No indexes beyond the implicit unique on `code`.

---

## Cart

### `Cart`
| Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| userId | Uuid | **yes**, `@unique` — one cart per user; `null` = a guest cart in theory, though in practice every caller is an authenticated user (guest sessions are real `User` rows) |
| appliedPromoId | Uuid | **yes** — FK → `PromoCode.id`, `onDelete: SetNull` |
| createdAt/updatedAt | DateTime | no |

**Relations**: `user?`, `appliedPromo?`, `items[]`.
`deliveryFee`/`taxRate` are **deliberately not columns here** — always read live from `RestaurantSettings` at request time so the client can never influence them via a stale cart.

### `CartItem`
| Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| cartId | Uuid | no — FK, **Cascade** |
| menuItemId | Uuid | no — FK → `MenuItem.id`, `onDelete: Restrict` (a menu item **cannot** be hard-deleted while a cart references it — moot in practice since menu-item deletion is soft) |
| selectedVariantId | Uuid | **yes** — FK → `ItemVariant.id`, `onDelete: SetNull` |
| quantity | Int | no |
| specialInstructions | String | **yes** |
| createdAt/updatedAt | DateTime | no |

**Indexes**: `@@index([cartId])`, `@@index([menuItemId])`. **Relations**: `cart`, `menuItem`, `selectedVariant?`, `addons[]`.
`unitPrice`/`totalPrice` are **never stored** — computed fresh on every read by `PricingService`.

### `CartItemAddon`
Join table. | Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| cartItemId | Uuid | no — FK, **Cascade** |
| addonId | Uuid | no — FK → `Addon.id`, `onDelete: Restrict` |

**Unique**: `@@unique([cartItemId, addonId])` (can't select the same addon twice on one line). **Indexes**: `@@index([cartItemId])`, `@@index([addonId])`.

---

## Orders

### `Order`
Never hard-deleted.

| Column | Type | Nullable | Notes |
|---|---|---|---|
| id | Uuid | no | |
| orderNumber | String | no, **unique** | format `KZ-YYMMDD-<8hex>`, generated with retry-on-collision (up to 5 attempts) |
| userId | Uuid | no | FK → `User.id`, `onDelete: Restrict` |
| status | OrderStatus | no, default `PENDING` | |
| subtotal, deliveryFee, tax, discount, totalAmount | Decimal(10,2) | no | all server-computed, frozen at checkout time |
| deliveryMethod | DeliveryMethod | no | |
| paymentMethod | PaymentMethod | no | |
| paymentStatus | PaymentStatus | no, default `PENDING` | |
| appliedPromoId | Uuid | **yes** | FK → `PromoCode.id`, `onDelete: SetNull` |
| promoCodeSnapshot | String | **yes** | frozen copy of the code string, survives promo edits/deletes |
| deliveryAddressJson | Json | no | full address snapshot, or `{ "type": "PICKUP" }` |
| estimatedDeliveryTime | DateTime | **yes** | **column exists but nothing in the codebase ever sets it** — always `null` today |
| createdAt/updatedAt | DateTime | no | |
| cancelledAt | DateTime | **yes** | **column exists but is never written** by any current service code (cancellation only updates `status`) |
| cancelReason | String | **yes** | same — column exists, never written |

**Indexes**: `@@index([userId])`, `@@index([status])`, `@@index([createdAt])`.
**Relations**: `user`, `appliedPromo?`, `items[]`, `statusHistory[]`, `payments[]`.

### `OrderItem`
Immutable snapshot row — **no `updatedAt`** by design.

| Column | Type | Nullable | Notes |
|---|---|---|---|
| id | Uuid | no | |
| orderId | Uuid | no | FK, **Cascade** |
| menuItemId | Uuid | **yes** | **soft reference, not an FK** — catalog deletes never orphan this |
| quantity | Int | no | |
| unitPrice, lineTotal | Decimal(10,2) | no | |
| specialInstructions | String | **yes** | |
| nameArSnapshot, nameEnSnapshot | String | no | |
| imageUrlSnapshot | String | **yes** | |
| createdAt | DateTime | no | |

**Indexes**: `@@index([orderId])`. **Relations**: `order`, `customizations[]`.

### `OrderItemCustomization`
Immutable snapshot of a chosen variant/addon at order time.

| Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| orderItemId | Uuid | no — FK, **Cascade** |
| kind | OrderItemCustomizationKind | no (`VARIANT` or `ADDON`) |
| refId | Uuid | **yes** — soft reference to the original variant/addon, not an FK |
| nameArSnapshot, nameEnSnapshot | String | no |
| priceSnapshot | Decimal(10,2) | no |
| createdAt | DateTime | no |

**Indexes**: `@@index([orderItemId])`.

### `OrderStatusHistory`
Powers both the customer tracking timeline and the admin audit trail.

| Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| orderId | Uuid | no — FK, **Cascade** |
| fromStatus | OrderStatus | **yes** — null on the very first (creation) row |
| toStatus | OrderStatus | no |
| changedByUserId | Uuid | **yes** — FK → `User.id`, `onDelete: SetNull` |
| note | String | **yes** |
| createdAt | DateTime | no |

**Indexes**: `@@index([orderId])`.

---

## `Payment`
Gateway-agnostic. No real gateway integration exists — see `payment-provider.interface.ts` notes in `02_API_REFERENCE.md`.

| Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| orderId | Uuid | no — FK, **Cascade** |
| method | PaymentMethod | no |
| status | PaymentStatus | no, default `PENDING` |
| amount | Decimal(10,2) | no |
| currency | String | no |
| provider | String | **yes** |
| providerRef | String | **yes** |
| idempotencyKey | String | no, **unique** — namespaced `user:<userId>:<header-value>` (or `auto:<uuid>` when no header was sent) |
| rawWebhookJson | Json | **yes** |
| createdAt/updatedAt | DateTime | no |

**Indexes**: `@@index([orderId])`, `@@index([providerRef])`.

---

## `DeviceToken`
FCM token registry — multi-device, guest-tolerant.

| Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| userId | Uuid | **yes** — FK → `User.id`, `onDelete: SetNull` |
| token | String | no, **unique** |
| platform | DevicePlatform | no |
| lastSeenAt | DateTime | no |
| isActive | Boolean | no, default `true` |
| createdAt/updatedAt | DateTime | no |

**Indexes**: `@@index([userId])`, `@@index([isActive])`.
`isActive` is flipped `false` (never hard-deleted) when FCM reports the token permanently invalid.

---

## `RestaurantSettings`
Singleton — exactly one row, enforced by a **unique boolean marker**.

| Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| singleton | Boolean | no, `@unique`, default `true` — the mechanism that guarantees at most one row |
| restaurantName | String | no |
| phone | String | no |
| addressText | String | no |
| taxRatePercent | Decimal(10,2) | no |
| deliveryFee | Decimal(10,2) | no |
| minOrderAmount | Decimal(10,2) | no |
| currency | String | no |
| workingHours | Json | no — `{ open, close }` shape by convention, not schema-enforced |
| isMaintenanceMode | Boolean | no, default `false` |
| updatedAt | DateTime | no |

No `createdAt` column on this model (only one row ever exists).

---

## `NotificationCampaign`
| Column | Type | Nullable | Notes |
|---|---|---|---|
| id | Uuid | no | |
| campaignName, title, body | String | no | |
| imageUrl | String | **yes** | |
| type | String | no | plain string, validated only at the DTO layer against 14 literal values |
| targetAudience | CampaignTargetAudience | no, default `ALL` | |
| destinationRoute | String | **yes** | |
| entityId | String | **yes** | |
| status | CampaignStatus | no, default `DRAFT` | |
| isScheduled | Boolean | no, default `false` | |
| scheduledAt | DateTime | **yes** | |
| sentAt | DateTime | **yes** | |
| totalRecipients | Int | no, default `0` | |
| deliveredCount | Int | no, default `0` | |
| openedCount | Int | no, default `0` | **never incremented anywhere** — no open-tracking exists |
| clickRate | Decimal(5,2) | no, default `0` | **never computed anywhere** |
| createdByUserId | Uuid | no | FK → `User.id`, `onDelete: Restrict` |
| createdAt/updatedAt | DateTime | no | |

**Indexes**: `@@index([status])`, `@@index([scheduledAt])`.

---

## `Address`
| Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| userId | Uuid | no — FK, **Cascade** |
| title, street, building, city | String | no |
| floor, apartment, notes | String | **yes** |
| latitude, longitude | Decimal(9,6) | **yes** |
| isDefault | Boolean | no, default `false` |
| createdAt/updatedAt | DateTime | no |

**Indexes**: `@@index([userId])`. "At most one `isDefault: true` per user" is enforced in `AddressesService`, **not** at the DB level (Prisma can't express a partial unique index in its schema DSL — same limitation as `User.email`).

---

## `Favorite`
| Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| userId | Uuid | no — FK, **Cascade** |
| menuItemId | Uuid | no — FK, **Cascade** |
| createdAt | DateTime | no |

**Unique**: `@@unique([userId, menuItemId])` — the actual duplicate-favorite guard (service-level check is just a friendlier pre-check before hitting this constraint). **Indexes**: `@@index([userId])`.

---

## `LoyaltyAccount`
| Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| userId | Uuid | no, `@unique` — FK, **Cascade** |
| pointsBalance | Int | no, default `0` |
| createdAt/updatedAt | DateTime | no |

**Relations**: `user`, `transactions[]`. Created lazily (upsert) on first read/earn — no explicit "create account" step.

## `LoyaltyTransaction`
Immutable ledger. `pointsBalance` on the account is a cached running total kept in sync transactionally with every insert here.

| Column | Type | Nullable |
|---|---|---|
| id | Uuid | no |
| accountId | Uuid | no — FK, **Cascade** |
| delta | Int | no — positive (earn) or negative (redemption) |
| reason | String | no — currently always `"ORDER_EARNED"` or `"REDEMPTION"` |
| orderId | Uuid | **yes** — soft reference, not an FK. `null` for a manual redemption (`POST /me/loyalty/redeem`); set to the real order id for a checkout-time redemption (`CheckoutDto.redeemRewardId`) |
| rewardId | String | **yes** — which `LOYALTY_REWARDS` catalog entry a `"REDEMPTION"` row corresponds to (e.g. `"free-delivery"`). `null` for `"ORDER_EARNED"` rows and for any row that predates this column (migration `20260724211600_loyalty_transaction_reward_id`) |
| createdAt | DateTime | no |

**Unique**: `@@unique([orderId, reason])` — the idempotency guard against double-awarding points for the same order. This same constraint now also guards against double-redeeming a checkout-time reward for the same order (a retried checkout call cannot insert a second `("REDEMPTION", <that orderId>)` row). Postgres treats distinct `NULL`s as non-conflicting, so manual redemptions (`orderId: null`) are unaffected by this constraint and can repeat freely. **Indexes**: `@@index([accountId])`.
