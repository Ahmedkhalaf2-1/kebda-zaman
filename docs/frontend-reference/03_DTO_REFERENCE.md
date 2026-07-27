# 03 — DTO Reference

Every request DTO (`class-validator`-decorated, enforced by the global `ValidationPipe`) and every response
shape (plain TypeScript interfaces, not runtime-validated — but exactly what the mapper functions produce) in
the codebase. Grouped by module, matching `02_API_REFERENCE.md`.

Legend: **Opt** = optional (`?`), **Null** = the field can legitimately be `null` in a **response**, or the DTO
explicitly types it `| null` for a **request**. "Default" = value applied server-side when the field is omitted.

---

## Auth

### `RegisterDto` (request)
| field | type | opt | validation |
|---|---|---|---|
| name | string | no | 2-100 chars |
| email | string | no | valid email, ≤255 |
| password | string | no | 8-72 chars |
| phone | string | yes | ≤30 chars |

### `GuestDto` (request)
| field | type | opt | validation | note |
|---|---|---|---|---|
| deviceId | string | yes | ≤200 chars | accepted, currently unused server-side |

### `LoginDto` (request) — shared by customer and admin login
| field | type | opt | validation |
|---|---|---|---|
| email | string | no | valid email, ≤255 |
| password | string | no | 1-72 chars |

### `LogoutDto` (request)
| field | type | opt | validation |
|---|---|---|---|
| refreshToken | string | yes | none beyond `IsString` |

### `RefreshDto` (request)
| field | type | opt | validation |
|---|---|---|---|
| refreshToken | string | no | min length 1 |

### `AuthResult` (response — register/login/admin-login/guest)
```ts
{ user: UserResponseDto, accessToken: string, refreshToken: string }
```

### `UserResponseDto` (response)
| field | type | null | note |
|---|---|---|---|
| id | string (uuid) | no | |
| name | string | no | maps from DB `fullName` |
| email | string | **yes** | null for guests |
| phone | string | **yes** | |
| avatarUrl | string | **yes** | |
| role | `"CUSTOMER" \| "ADMIN"` | no | |
| isGuest | boolean | no | |
| locale | string | no | `"en"` or `"ar"` in practice |
| createdAt | ISO string | no | |

`passwordHash` is **never** present on this shape (deliberately field-picked, never spread).

---

## Users

### `UpdateProfileDto` (request) — all fields optional (PATCH semantics)
| field | type | opt | validation |
|---|---|---|---|
| name | string | yes | 2-100 chars |
| phone | string | yes | ≤30 chars |
| avatarUrl | string | yes | ≤2048 chars, no URL-format check |
| locale | string | yes | must be exactly `"ar"` or `"en"` |

Response: `UserResponseDto` (above). Note: this DTO's types do **not** allow explicit `null` — you can omit a field to leave it unchanged, but cannot null it out via this endpoint.

---

## Catalog

### `CategoryDto` (request — same shape for create and full-replace update)
| field | type | opt | validation | default |
|---|---|---|---|---|
| nameAr | string | no | non-empty, ≤100 | |
| nameEn | string | no | non-empty, ≤100 | |
| iconUrl | string | yes | ≤2048 | |
| displayOrder | int | yes | ≥0 | `0` on create; unchanged on update if omitted |

### `CategoryResponseDto` / `AdminCategoryResponseDto` (response)
| field | type | null | note |
|---|---|---|---|
| id | string | no | |
| nameAr / nameEn | string | no | |
| iconUrl | string | **yes** | |
| displayOrder | int | no | |
| isActive | boolean | no | **admin shape only** |

### `MenuItemDto` (request — same shape for create and full-replace update)
| field | type | opt | validation | default |
|---|---|---|---|---|
| categoryId | string (uuid) | no | must reference an existing category | |
| nameAr / nameEn | string | no | non-empty, ≤150 | |
| descriptionAr / descriptionEn | string | no | non-empty (no max length) | |
| basePrice | number | no | ≥0 | |
| imageUrl | string \| null | **yes, and nullable** | ≤2048 chars if present | `null` |
| isAvailable | boolean | yes | | `true` on create; unchanged on update |
| isPopular | boolean | yes | | `false` on create; unchanged on update |
| displayOrder | int | yes | ≥0 | unset on create; unchanged on update |
| variants | `VariantDto[]` | yes | | omitted = don't touch existing variants (update only) |
| addonGroups | `AddonGroupDto[]` | yes | | omitted = don't touch existing addon groups (update only) |

`imageUrl` optionality was a deliberate fix — earlier the field was required; it is now fully optional/nullable, matching the DB column (`String?`).

#### `VariantDto` (nested)
| field | type | opt | validation |
|---|---|---|---|
| id | string (uuid) | yes | present = update this row; absent = create a new one |
| nameAr / nameEn | string | no | non-empty, ≤100 |
| priceDelta | number | no | can be negative (a "smaller size" discount) — no `Min` constraint |
| isDefault | boolean | yes | default `false` |
| isActive | boolean | yes | default `true` |
| displayOrder | int | yes | ≥0 |

#### `AddonGroupDto` (nested)
| field | type | opt | validation | default |
|---|---|---|---|---|
| id | string (uuid) | yes | present = update, absent = create | |
| titleAr / titleEn | string | no | non-empty, ≤100 | |
| isRequired | boolean | yes | | `false` |
| minSelect | int | yes | ≥0 | `0` |
| maxSelect | int | yes | ≥0 | `1` |
| displayOrder | int | yes | ≥0 | |
| addons | `AddonDto[]` | no (required array, can be empty) | | |

#### `AddonDto` (nested)
| field | type | opt | validation | default |
|---|---|---|---|---|
| id | string (uuid) | yes | present = update, absent = create | |
| nameAr / nameEn | string | no | non-empty, ≤100 | |
| price | number | no | ≥0 | |
| isAvailable | boolean | yes | | `true` |
| displayOrder | int | yes | ≥0 | |

### `SetAvailabilityDto` (request)
| field | type | opt |
|---|---|---|
| isAvailable | boolean | no |

### `ListMenuItemsDto` (request — query params)
| field | type | opt | validation | default |
|---|---|---|---|---|
| categoryId | string (uuid) | yes | | |
| page | int | yes | ≥1 | `1` |
| limit | int | yes | 1-100 | `20` |

### `SearchMenuDto` (request — query params)
| field | type | opt | validation |
|---|---|---|---|
| q | string | no | non-empty, ≤200 |

### `AdminListMenuItemsDto` (request — query params)
| field | type | opt | validation |
|---|---|---|---|
| categoryId | string (uuid) | yes | |
| q | string | yes | ≤150 |

### `MenuItemResponseDto` (public response shape)
| field | type | null |
|---|---|---|
| id, categoryId | string | no |
| nameAr, nameEn | string | no |
| descriptionAr, descriptionEn | string | no |
| basePrice | number | no |
| imageUrl | string | **yes** |
| isAvailable, isPopular | boolean | no |
| variants | `ItemVariantResponseDto[]` | no (can be `[]`) — only `isActive: true` rows |
| addonGroups | `AddonGroupResponseDto[]` | no — each group's `addons[]` only includes `isAvailable: true` rows |

`ItemVariantResponseDto`: `{ id, nameAr, nameEn, priceDelta: number, isDefault: boolean }`
`AddonResponseDto`: `{ id, nameAr, nameEn, price: number }`
`AddonGroupResponseDto`: `{ id, titleAr, titleEn, isRequired, minSelect, maxSelect, addons: AddonResponseDto[] }`

### `AdminMenuItemResponseDto` (admin response shape)
Same as `MenuItemResponseDto` **plus** `displayOrder: number | null`, and:
- `variants`: **every** row (not just `isActive`), each also carrying `isActive: boolean` and `displayOrder: number | null`.
- `addonGroups[].addons`: **every** row (not just `isAvailable`), each also carrying `isAvailable: boolean` and `displayOrder: number | null`; each group also carries `displayOrder: number | null`.

---

## Settings

### `WorkingHoursDto` (nested request)
| field | type | validation |
|---|---|---|
| open | string | matches `/^([01]\d\|2[0-3]):[0-5]\d$/` (24h `HH:MM`) |
| close | string | same |

### `UpdateSettingsDto` (request — full replace, every field required)
| field | type | validation |
|---|---|---|
| restaurantName | string | non-empty, ≤200 |
| phone | string | non-empty, ≤50 |
| addressText | string | non-empty, ≤500 |
| taxRatePercent | number | 0-100 |
| deliveryFee | number | ≥0 |
| minOrderAmount | number | ≥0 |
| currency | string | non-empty, ≤10 |
| workingHours | `WorkingHoursDto` | required nested object |
| isMaintenanceMode | boolean | required |

### `PublicSettingsResponseDto` / `AdminSettingsResponseDto` (response)
Public: `{ deliveryFee, taxRatePercent, minOrderAmount, workingHours: unknown (raw JSON), isMaintenanceMode }` — all numbers, no nulls.
Admin adds: `{ id, restaurantName, phone, addressText, currency, updatedAt }`.

---

## Cart

### `AddCartItemDto` (request)
| field | type | opt | validation |
|---|---|---|---|
| menuItemId | string (uuid) | no | |
| variantId | string (uuid) | yes | |
| addonIds | string[] (uuid v4) | yes | each must be a v4 UUID |
| quantity | int | no | ≥1 |
| specialInstructions | string | yes | ≤500 |

### `UpdateCartItemDto` (request — merge-patch, all optional)
| field | type | opt | null | validation | semantics if omitted |
|---|---|---|---|---|---|
| quantity | int | yes | no | ≥1 | unchanged |
| variantId | string (uuid) | yes | **yes** | | unchanged |
| addonIds | string[] (uuid v4) | yes | no | | unchanged (send `[]` to clear) |
| specialInstructions | string | yes | **yes** | ≤500 | unchanged |

### `ApplyPromoDto` (request)
| field | type | opt | validation |
|---|---|---|---|
| code | string | no | non-empty, ≤50 |

### `CartResponseDto` (response)
```ts
{ items: CartItemResponseDto[], appliedPromo: PromoResponseDto | null, deliveryFee: number, taxRate: number }
```

### `CartItemResponseDto` (response)
| field | type | null |
|---|---|---|
| id | string | no |
| menuItem | `MenuItemResponseDto` | no |
| selectedVariant | `ItemVariantResponseDto` | **yes** |
| selectedAddons | `AddonResponseDto[]` | no (can be `[]`) |
| quantity | int | no |
| specialInstructions | string | **yes** |
| unitPrice, totalPrice | number | no |
| isAvailable | boolean | no | `false` when the line has gone stale (see notes in `02_API_REFERENCE.md`) |

### `PromoResponseDto` (response — customer-facing subset)
`{ code, discountType: "PERCENT" | "FIXED", value: number, minOrderAmount: number | null, maxDiscountAmount: number | null }`

### `AdminPromoResponseDto` (response — extends the above)
Adds: `{ id, maxUsage: number | null, usageCount: number, perUserLimit: number | null, startsAt: string | null, expiresAt: string | null, isActive: boolean, createdAt: string, updatedAt: string }`

---

## Promos

### `ValidatePromoDto` (request)
| field | type | opt | validation | note |
|---|---|---|---|---|
| code | string | no | non-empty, ≤50 | |
| subtotal | number | yes | | **accepted but ignored** by the service |

### `ValidatePromoResponseDto` (response)
`{ valid: true, discountType: "PERCENT" | "FIXED", value: number, computedDiscount: number }`

### `PromoDto` (request — same shape for create and full-replace update)
| field | type | opt | validation | default |
|---|---|---|---|---|
| code | string | no | non-empty, ≤50 (server uppercases/trims) | |
| discountType | `"PERCENT" \| "FIXED"` | no | enum | |
| value | number | no | ≥0 | |
| minOrderAmount | number | yes | ≥0 | `null` |
| maxDiscountAmount | number | yes | ≥0 | `null` |
| maxUsage | int | yes | ≥1 | `null` (unlimited) |
| perUserLimit | int | yes | ≥1 | `null` — **stored but not enforced** |
| startsAt | ISO date string | yes | | `null` |
| expiresAt | ISO date string | yes | | `null` |
| isActive | boolean | yes | | `true` on create; unchanged on update |

---

## Checkout & Orders

### `DeliveryAddressDto` (nested request, inline only — not a saved-address reference)
| field | type | opt | validation |
|---|---|---|---|
| title | string | no | non-empty, ≤100 |
| street | string | no | non-empty, ≤200 |
| building | string | no | non-empty, ≤100 |
| floor | string | yes | ≤50 |
| apartment | string | yes | ≤50 |
| city | string | no | non-empty, ≤100 |

### `CheckoutDto` (request)
| field | type | opt | validation |
|---|---|---|---|
| deliveryMethod | `"DELIVERY" \| "PICKUP"` | no | enum |
| paymentMethod | `"CASH" \| "CARD" \| "WALLET"` | no | enum (only `CASH` actually works end-to-end today) |
| deliveryAddress | `DeliveryAddressDto` | yes* | required when `deliveryMethod === "DELIVERY"` (service-level, not DTO-level) |
| promoCode | string | yes | ≤50 — mutually exclusive with `redeemRewardId` (service-level check: `422 PROMO_AND_LOYALTY_MUTUALLY_EXCLUSIVE` if both are sent) |
| redeemRewardId | string | yes | non-empty, ≤50 — one of the fixed loyalty reward ids (`free-delivery`/`discount-10`/`discount-25`); redeemed atomically inside the checkout transaction, see `02_API_REFERENCE.md` and `05_ORDER_LIFECYCLE.md` |
| notes | string | yes | ≤1000 |

No monetary field exists anywhere on this DTO — the server prices everything.

### `ListOrdersDto` / `AdminListOrdersDto` (request — query params)
| field | type | opt | validation | default |
|---|---|---|---|---|
| status | one of `pending\|confirmed\|preparing\|outForDelivery\|delivered\|cancelled` | yes | `IsIn` | |
| q | string | yes (admin only) | ≤100 | |
| page | int | yes | ≥1 | `1` |
| limit | int | yes | customer: ≥1, no cap. admin: 1-100 | `20` |

### `UpdateOrderStatusDto` (request)
| field | type | opt | validation |
|---|---|---|---|
| status | same lowerCamel status enum | no | |
| note | string | yes | ≤1000 |

### `OrderResponseDto` (response)
| field | type | null |
|---|---|---|
| id, orderNumber, userId | string | no |
| user | `UserResponseDto` | no |
| items | `OrderItemResponseDto[]` | no |
| status | lowerCamel string | no |
| deliveryAddress | `unknown` (raw JSON — either the address snapshot or `{ type: "PICKUP" }`) | no |
| paymentMethod | lowercase string (`"cash" \| "card" \| "wallet"`) | no |
| subtotal, deliveryFee, tax, discount, totalAmount | number | no |
| createdAt | ISO string | no |
| estimatedDeliveryTime | ISO string | **yes** — always `null` today (nothing in the codebase ever sets this column) |
| loyaltyRedemption | `{ rewardId: string, rewardName: string, pointsRedeemed: number }` | **yes** — additive field, `null` when no reward was redeemed for this order (the normal case). Populated only on the checkout response and on a subsequent idempotent-retry of that same checkout call; `GET /orders/:id` and other read endpoints do not currently look this up (see `09_FRONTEND_INTEGRATION.md`) — use `GET /me/loyalty/transactions` (filter by `orderId`) if you need it outside the checkout response itself. |

### `OrderItemResponseDto` (response, nested in `items[]`)
| field | type | null |
|---|---|---|
| id | string | no |
| menuItem | `{ nameAr, nameEn, imageUrl: string \| null }` | — this is an **immutable snapshot**, not a live catalog lookup |
| selectedVariant | `{ id, nameAr, nameEn, priceSnapshot: number }` | **yes** |
| selectedAddons | same shape, array | no (can be `[]`) |
| quantity | int | no |
| specialInstructions | string | **yes** |
| unitPrice, totalPrice | number | no |

### `OrderStatusResponseDto` (response)
`{ status: string, statusHistory: { status: string, note: string | null, changedAt: string }[], estimatedDeliveryTime: string | null }`

---

## Payments

### `CreateIntentDto` (request)
| field | type | opt |
|---|---|---|
| orderId | string (uuid) | no |

### `WebhookQueryDto` (request — query param)
| field | type | opt |
|---|---|---|
| provider | string | no |

### `PaymentResponseDto` (response)
`{ id, orderId, method: string, status: "PENDING"|"PAID"|"FAILED"|"REFUNDED", amount: number, currency, provider: string | null, providerRef: string | null, createdAt, updatedAt }`

### `PaymentIntentResponseDto` (response)
`{ paymentId, status, providerData?: Record<string, unknown> }`

---

## Devices

### `RegisterDeviceDto` (request)
| field | type | opt | validation |
|---|---|---|---|
| token | string | no | non-empty, ≤4096 |
| platform | `"ANDROID"\|"IOS"\|"WEB"\|"MACOS"\|"WINDOWS"` | no | enum |

### `UpdateDeviceTokenDto` (request)
| field | type | opt | validation |
|---|---|---|---|
| oldToken | string | yes | ≤4096 |
| token | string | no | non-empty, ≤4096 |
| platform | same enum | no | |

### `DeleteDeviceTokenDto` (request)
| field | type | opt |
|---|---|---|
| token | string | no |

### Response (register/update — raw `DeviceToken` Prisma row, no dedicated mapper)
`{ id, userId: string | null, token, platform, lastSeenAt: Date, isActive: boolean, createdAt: Date, updatedAt: Date }`
Note: these are **not** ISO-string-mapped by hand like other responses — Nest's default JSON serialization turns Prisma `Date` objects into ISO strings automatically, so on the wire it looks the same, but be aware this response shape was never explicitly hand-mapped like the others (no field-picking — if the `DeviceToken` model ever gains a sensitive column, it would appear here).

---

## Addresses

### `AddressDto` (request — same shape for create and full-replace update)
| field | type | opt | validation | default |
|---|---|---|---|---|
| title | string | no | non-empty, ≤100 | |
| street | string | no | non-empty, ≤200 | |
| building | string | no | non-empty, ≤100 | |
| floor | string | yes | ≤50 | `null` |
| apartment | string | yes | ≤50 | `null` |
| city | string | no | non-empty, ≤100 | |
| notes | string | yes | ≤1000 | `null` |
| latitude | number | yes | | `null` |
| longitude | number | yes | | `null` |
| isDefault | boolean | yes | | see service notes in `02` |

### `AddressResponseDto` (response)
`{ id, userId, title, street, building, floor: string|null, apartment: string|null, city, notes: string|null, latitude: number|null, longitude: number|null, isDefault: boolean, createdAt, updatedAt }`

---

## Favorites

### `AddFavoriteDto` (request)
| field | type | opt |
|---|---|---|
| menuItemId | string (uuid) | no |

Response: `MenuItemResponseDto[]` (see Catalog section above) for both `GET` and `POST`.

---

## Loyalty

### `RedeemDto` (request)
| field | type | opt |
|---|---|---|
| rewardId | string | no — must match one of the fixed catalog ids, see `02_API_REFERENCE.md` |

### `LoyaltyAccountResponseDto` (response)
`{ id, userId, pointsBalance: number, createdAt, updatedAt }`

### `LoyaltyTransactionResponseDto` (response)
`{ id, delta: number (can be negative), reason: string, orderId: string | null, rewardId: string | null, createdAt }`

`rewardId` (new field) identifies which fixed-catalog reward a `"REDEMPTION"` row corresponds to — `null` for `"ORDER_EARNED"` rows and for any row created before this field existed. `orderId` is set for a checkout-time redemption (via `CheckoutDto.redeemRewardId`) and `null` for a manual redemption via `POST /me/loyalty/redeem`.

---

## Admin Notifications

### `CampaignDto` (request — shared base for send/schedule)
| field | type | opt | validation | default |
|---|---|---|---|---|
| campaignName | string | no | non-empty, ≤150 | |
| title | string | no | non-empty, ≤150 | |
| body | string | no | non-empty, ≤1000 | |
| imageUrl | string | yes | ≤2048 | |
| type | one of 14 `NotificationType` values | no | `IsIn` — see `08_NOTIFICATION_REFERENCE.md` | |
| targetAudience | `"ALL"\|"CUSTOMERS"\|"GUESTS"` | yes | enum | `ALL` |
| destinationRoute | string | yes | ≤500 | |
| entityId | string | yes | ≤100 | |

### `ScheduleCampaignDto` (request) — extends `CampaignDto`
| field | type | opt | validation |
|---|---|---|---|
| scheduledAt | string | no | ISO date string |

### `ListCampaignsDto` (request — query params)
| field | type | opt | validation | default |
|---|---|---|---|---|
| page | int | yes | ≥1 | `1` (fixed page size of 20, not a request param) |

### `AdminCampaignResponseDto` (response)
`{ id, campaignName, title, body, imageUrl: string|null, type: string, targetAudience, destinationRoute: string|null, entityId: string|null, status: "DRAFT"|"SCHEDULED"|"SENDING"|"SENT"|"FAILED", isScheduled: boolean, scheduledAt: string|null, sentAt: string|null, totalRecipients: number, deliveredCount: number, openedCount: number, clickRate: number, createdAt: string }`

Note: `openedCount` and `clickRate` exist on the schema/response but **nothing in the codebase ever increments them** — there is no open/click tracking endpoint. They will always read `0`.

---

## Uploads

No request DTO (raw multipart file, validated by Multer's `fileFilter`/`limits`, not `class-validator`).

### `UploadImageResponseDto` (response)
`{ imageUrl: string }`
