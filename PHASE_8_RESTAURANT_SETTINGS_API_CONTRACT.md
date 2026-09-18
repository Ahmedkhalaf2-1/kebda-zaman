# Phase 8A — Restaurant Settings & Delivery Configuration API Contract

Scope: restaurant profile, weekly operating hours, manual order-acceptance
state, and ADMIN-managed delivery zones. All endpoints are versioned under
`/api/v1`.

## What already existed vs. what Phase 8 added

**Already existed** (reused, not duplicated):
- `RestaurantSettings` singleton row (`GET/PUT /admin/settings`, public `GET /settings`).
- `phone`, `taxRatePercent`, `deliveryFee`, `minOrderAmount`, `currency`, `isMaintenanceMode` fields — unchanged.
- `PricingService.priceCart` as the single authoritative pricing function.
- `OrdersService.checkout`'s existing `BELOW_MIN_ORDER` global-floor check.
- `POST /admin/uploads/image` for image hosting (reused for `logoUrl`, no new upload endpoint).
- The `ADMIN`/`CASHIER`/`CUSTOMER` role guard pipeline (`JwtAccessGuard` → `RolesGuard` → `@Roles()`).
- Order's existing `deliveryFee` column, reused as-is as the per-order fee snapshot (no new "fee snapshot" column needed).

**Missing before Phase 8** (added now):
- Bilingual restaurant name/address (`restaurantName`/`addressText` were single-language).
- `logoUrl`.
- Real per-day weekly operating hours (`workingHours` was one flat `{open,close}` pair for the whole week).
- A restaurant `timezone` field.
- A manual `acceptingOrders` checkout gate + closed-message text.
- Delivery zones entirely (there was exactly one flat, global `deliveryFee`/`minOrderAmount` — no per-area pricing).
- Any `deliveryZoneId` concept on `Order`.

## Authorization

- Restaurant settings writes (`PUT /admin/settings`) and delivery-zone management (`POST`/`PATCH`/`DELETE`/admin `GET /admin/delivery-zones`): **`ADMIN` only**. `CASHIER` → `403`, `CUSTOMER` → `403`.
- Public `GET /settings` and public `GET /delivery-zones`: no auth required (`@Public()`).
- Checkout's delivery-zone/acceptance enforcement applies to `CUSTOMER` (and guest, same role) callers, unchanged from existing checkout auth.

## 1. Admin restaurant settings

### `GET /api/v1/admin/settings`
Returns everything the public endpoint returns, plus `id`, `currency`, `updatedAt`.

### `PUT /api/v1/admin/settings` (full replace)
```json
{
  "restaurantNameAr": "كبدة زمان", "restaurantNameEn": "Kebda Zaman",
  "logoUrl": "https://.../logo.png",
  "phone": "+20100000000",
  "addressAr": "القاهرة، مصر", "addressEn": "Cairo, Egypt",
  "taxRatePercent": 14, "deliveryFee": 20, "minOrderAmount": 50, "currency": "EGP",
  "workingHours": [
    { "dayOfWeek": 0, "isOpen": true, "openTime": "10:00", "closeTime": "02:00" },
    { "dayOfWeek": 1, "isOpen": true, "openTime": "10:00", "closeTime": "02:00" },
    { "dayOfWeek": 2, "isOpen": true, "openTime": "10:00", "closeTime": "02:00" },
    { "dayOfWeek": 3, "isOpen": true, "openTime": "10:00", "closeTime": "02:00" },
    { "dayOfWeek": 4, "isOpen": true, "openTime": "10:00", "closeTime": "02:00" },
    { "dayOfWeek": 5, "isOpen": true, "openTime": "10:00", "closeTime": "02:00" },
    { "dayOfWeek": 6, "isOpen": false, "openTime": null, "closeTime": null }
  ],
  "timezone": "Africa/Cairo",
  "isMaintenanceMode": false,
  "acceptingOrders": true,
  "closedMessageAr": null, "closedMessageEn": null
}
```
- `logoUrl`, `closedMessageAr`, `closedMessageEn` are the only optional/nullable fields — everything else is required (full-replace semantics, matching the pre-existing convention for this endpoint).
- `logoUrl` workflow: upload via the existing `POST /admin/uploads/image`, then pass the returned URL here. No dedicated logo-upload endpoint was added.
- **Fields intentionally not added**: WhatsApp number, email — the task scope only requires adding these "if already supported," and neither existed anywhere in the schema/codebase before Phase 8, so neither was added. Only `restaurantNameAr/En`, `logoUrl`, `addressAr/En` (explicitly requested) plus `phone` (reused) were implemented.

## 2. Public restaurant settings

### `GET /api/v1/settings` (public)
Same shape as admin, minus `id`, `currency`, `updatedAt` — those are considered
internal/operational, not customer-facing.

```json
{
  "restaurantNameAr": "...", "restaurantNameEn": "...", "logoUrl": null,
  "phone": "...", "addressAr": "...", "addressEn": "...",
  "deliveryFee": 20, "taxRatePercent": 14, "minOrderAmount": 50,
  "workingHours": [ /* 7 entries, see above */ ],
  "timezone": "Africa/Cairo",
  "acceptingOrders": true, "closedMessageAr": null, "closedMessageEn": null,
  "isMaintenanceMode": false
}
```

## 3. Operating hours

- `workingHours` is always exactly 7 entries, one per `dayOfWeek` (0-6), each unique. `0` = Sunday, following this project's existing `DevicePlatform`-style plain-integer convention (no separate day-name enum).
- `openTime`/`closeTime` are `"HH:MM"` 24-hour strings, regex-validated (`^([01]\d|2[0-3]):[0-5]\d$`). Both are **required when `isOpen: true`**, and are forced to `null` server-side when `isOpen: false` (whatever was submitted for a closed day is discarded — avoids stale/misleading data).
- **Overnight ranges are valid and un-normalized**: `openTime:"18:00", closeTime:"02:00"` is accepted as-is; no `openTime < closeTime` ordering is enforced. Interpreting the wraparound (i.e., "closes at 2am the next calendar day") is a display concern for Flutter, not something the backend resolves.
- **Timezone**: `timezone` is a new IANA-string field (e.g. `"Africa/Cairo"`), default `Africa/Cairo` (this restaurant's actual location, seeded at migration time). All `openTime`/`closeTime` values are defined relative to this timezone — **never the server's local timezone or the device's timezone**. Flutter must read `timezone` from settings and localize accordingly (e.g. via a timezone-aware date library), not assume UTC or device-local.
- **Hours are informational/display only.** They do not themselves open or close order acceptance — see §4. This preserves prior behavior exactly: the old flat `workingHours` was also purely informational (nothing in the codebase read it to gate any endpoint), so this is not a behavior change, only a richer data shape.

## 4. Order-acceptance state

- `acceptingOrders: boolean` — manual ADMIN toggle via `PUT /admin/settings`.
- `closedMessageAr`/`closedMessageEn: string|null` — optional message to display when closed.
- **Precedence**: `acceptingOrders` is the **only** checkout gate. Operating hours (§3) are never consulted to auto-derive acceptance — the task explicitly calls for not inferring automatic opening from hours unless that already happened, and it did not. If a future phase wants hours-based auto-closing, that is a distinct, additive feature — this phase does not touch it.
- Checkout behavior: `POST /checkout` (and its `/orders` alias) checks `acceptingOrders` first, before cart/zone validation. When `false`:
  - `422`, `code: "RESTAURANT_NOT_ACCEPTING_ORDERS"`, `message` = `closedMessageEn` (falls back to a generic string if unset), `details: { closedMessageAr, closedMessageEn }`.
- **Cart and menu browsing are entirely unaffected** — `GET /cart`, `POST /cart/items`, `GET /menu`, `GET /categories`, etc. all continue to work normally while closed. Only the checkout write path is gated.
- Closing the restaurant **does not cancel or otherwise touch existing orders** — no side effects beyond blocking new checkouts.

## 5. Delivery zones

### Schema
```
DeliveryZone {
  id, nameAr, nameEn,
  deliveryFee: Decimal(10,2) >= 0,
  minimumOrder: Decimal(10,2) >= 0,
  isActive: boolean (default true),
  sortOrder: int (default 0),
  createdAt, updatedAt, deletedAt (soft delete)
}
```
No polygons, coordinates, radius, or geofencing of any kind — a zone is just a named area with a flat fee and minimum, exactly as scoped.

### Admin endpoints (`ADMIN` only)
- `GET /api/v1/admin/delivery-zones` — all non-deleted zones (active and inactive), sorted `sortOrder` asc then `createdAt` asc.
- `POST /api/v1/admin/delivery-zones` — body `{ nameAr, nameEn, deliveryFee>=0, minimumOrder>=0, isActive?, sortOrder? }`. `201`.
- `PATCH /api/v1/admin/delivery-zones/:id` — same body shape, full-replace-style (matches this endpoint's task-specified verb; unlike Category/PromoCode's `PUT`, this resource uses `PATCH` per the approved spec). `200`.
- `DELETE /api/v1/admin/delivery-zones/:id` — soft delete (`deletedAt` set, `isActive` forced `false`), mirrors the existing `Category`/`PromoCode` soft-delete convention in this codebase. `204`. **Not blocked by historical orders** — an `Order` snapshots the zone's name at checkout time (`deliveryZoneNameArSnapshot`/`deliveryZoneNameEnSnapshot`) and its `deliveryFee` (existing `Order.deliveryFee` column), and the FK is `onDelete: SetNull`, so history stays fully readable regardless of the zone's later lifecycle.
- `deliveryFee`/`minimumOrder` < 0 → `400` (class-validator `@Min(0)`). Empty `nameAr`/`nameEn` → `400`.

### Public endpoint
- `GET /api/v1/delivery-zones` (no auth) — **active zones only** (`isActive: true, deletedAt: null`), sorted `sortOrder` asc then `createdAt` asc. Response per zone: `{ id, nameAr, nameEn, deliveryFee, minimumOrder, sortOrder }` (no `isActive`/timestamps — mirrors the public-vs-admin Category response split already used elsewhere in this API).

## 6. Cart and checkout integration

### DELIVERY orders
- `deliveryZoneId` (uuid) is now a field on `CheckoutDto`, **required when `deliveryMethod=DELIVERY`**.
- Resolution: the backend re-reads the zone fresh from the DB (`isActive: true, deletedAt: null`) on every checkout call — a client can only ever reference a zone by id, never supply a fee. There is no `deliveryFee` field anywhere on `CheckoutDto` — sending one is rejected outright by the global `forbidNonWhitelisted` validation (`400`), before any business logic runs.
- Missing `deliveryZoneId`, an unknown id, an inactive zone, or a soft-deleted zone are all indistinguishable to the client and all produce: `422`, `code: "DELIVERY_ZONE_UNAVAILABLE"`.
- Minimum-order enforcement for DELIVERY has **two independent floors**, both checked:
  1. Zone-specific (checked first): `subtotal < zone.minimumOrder` → `422`, `code: "MINIMUM_ORDER_NOT_MET"`, `details: { minimumOrder: number }`.
  2. Store-wide (pre-existing, unchanged): `subtotal < settings.minOrderAmount` → `422`, `code: "BELOW_MIN_ORDER"`.
- The resolved zone's `deliveryFee` becomes the order's authoritative `deliveryFee` (persisted on `Order.deliveryFee`, same column as before — no new fee column was needed). `RestaurantSettings.deliveryFee` is **no longer read** for DELIVERY pricing once a zone is required; it's kept in the schema/admin DTO only for backward compatibility (unused by current checkout logic, but not removed since another future context could still want a flat default).

### PICKUP orders
- `deliveryZoneId` is not required and is ignored if sent (same pattern as `deliveryAddress` being accepted-but-ignored for PICKUP).
- `deliveryFee` is always `0` (unchanged, pre-existing behavior).
- The zone minimum never applies to PICKUP — only the pre-existing store-wide `BELOW_MIN_ORDER` floor does.

### Order snapshot fields (new)
```
Order.deliveryZoneId              String? @db.Uuid   -- live FK (onDelete: SetNull), null for PICKUP
Order.deliveryZoneNameArSnapshot  String?            -- immutable, like promoCodeSnapshot
Order.deliveryZoneNameEnSnapshot  String?
```
`Order.deliveryFee` (pre-existing column) already serves as the fee-amount snapshot — no `minimumOrder` snapshot is stored on the order (it's a checkout-time gate only, not a fact about the order itself, per the task's "only if genuinely useful" guidance).

`OrderResponseDto` gained one additive field:
```json
"deliveryZone": { "id": "uuid", "nameAr": "...", "nameEn": "..." } // or null
```
`null` for PICKUP orders and for any order placed before Phase 8.

## 7. Cart response

`GET /cart`'s `deliveryFee` is **always `0`** — no `deliveryMethod`/`deliveryZone` exists at the cart stage (both are chosen at checkout), and Phase 8 made the real DELIVERY fee zone-specific, so a flat `settings.deliveryFee` passthrough would now actively mislead the customer before they've picked a zone. This is a behavior change from before Phase 8 (previously it echoed `settings.deliveryFee` unconditionally); `taxRate` is unaffected. Do not interpret cart's `deliveryFee: 0` as "free delivery" — it means "not yet determined," resolved only at checkout.

## Error codes introduced

| Code | Status | Meaning |
| --- | --- | --- |
| `RESTAURANT_NOT_ACCEPTING_ORDERS` | 422 | `acceptingOrders` is currently `false`. |
| `DELIVERY_ZONE_UNAVAILABLE` | 422 | DELIVERY order with a missing/unknown/inactive/deleted zone. |
| `MINIMUM_ORDER_NOT_MET` | 422 | Subtotal below the selected zone's `minimumOrder`. |
| `INVALID_WORKING_HOURS` | 400 | Malformed weekly-hours array (bad length, duplicate/missing `dayOfWeek`, or `isOpen:true` missing a time). |
| `DELIVERY_ZONE_NOT_FOUND` | 404 | Admin CRUD referencing an unknown/deleted zone id. |

All flow through the existing `AllExceptionsFilter` canonical error envelope; `MINIMUM_ORDER_NOT_MET` and `RESTAURANT_NOT_ACCEPTING_ORDERS` populate `details`.

## Migration notes

One hand-written migration (`20260728135522_restaurant_settings_and_delivery_zones`) — not machine-generated, because the schema changes needed a safe data backfill rather than a drop:
- `RestaurantSettings.restaurantName` → `restaurantNameAr` + `restaurantNameEn` (both backfilled from the old single value — no data lost).
- `RestaurantSettings.addressText` → `addressAr` + `addressEn` (same backfill pattern).
- `RestaurantSettings.workingHours` keeps its column name; its JSON content is transformed in-place from `{open,close}` to the 7-day array, with `isOpen: true` for every day and the old pair copied onto each — i.e. the restaurant's previously-effective hours are exactly preserved, just now expressed per-day.
- New columns added with safe defaults: `logoUrl` (nullable), `timezone` (`'Africa/Cairo'`), `acceptingOrders` (`true`), `closedMessageAr`/`closedMessageEn` (nullable).
- New `DeliveryZone` table, indexed on `(isActive, sortOrder)` for the public/admin listing queries.
- New `Order.deliveryZoneId` (indexed, FK `onDelete: SetNull`) + two snapshot columns, all nullable — every existing `Order` row is valid as-is (`deliveryZone: null` in the API response).

No destructive operations, no `prisma migrate reset`, no edits to any prior migration file.

## Tests

New: `test/restaurant-settings.restaurant-settings-spec.ts` (`npm run test:restaurant-settings`) — 14 tests covering admin read/update, CASHIER/CUSTOMER write rejection, public-fields-only exposure, zone CRUD authorization, negative fee/minimum rejection, public active-zone ordering, zone-required/inactive-zone checkout rejection, client-fee rejection, correct zone fee applied, zone-minimum enforcement, PICKUP zero-fee/no-zone behavior, and the closed-restaurant checkout gate (with cart/menu still reachable).

Updated existing tests to match the new schema/behavior (mechanical consequence of the field changes above, not unrelated edits): `test/admin-platform.admin-platform-spec.ts`, `test/db/constraints.db-spec.ts`, `test/orders.orders-spec.ts`, `test/admin-reports.admin-reports-spec.ts` (all DELIVERY-order test fixtures now create and pass a real `deliveryZoneId`).

## Flutter integration notes

- Fetch `GET /delivery-zones` before showing a DELIVERY checkout flow; let the customer pick one; send its `id` as `deliveryZoneId`. Do not let the customer type/select a fee — there is nowhere to put it.
- Read `settings.acceptingOrders` (and `closedMessageAr`/`closedMessageEn`) to show a "currently closed" banner proactively, but still attempt checkout normally — the backend is the enforcement point regardless of what the client shows.
- `settings.workingHours` + `settings.timezone` are for display only (e.g. an "Hours" screen); do not use them to disable the order button — that's what `acceptingOrders` is for.
- Cart's `deliveryFee` is always `0` — do not show it as a real number until after a zone is chosen at checkout; show the real per-order fee only from the `Order` response.
- `order.deliveryZone` is additive/nullable — existing Flutter code that ignores unknown JSON fields needs no changes to keep working; only update it when ready to display the zone name.
