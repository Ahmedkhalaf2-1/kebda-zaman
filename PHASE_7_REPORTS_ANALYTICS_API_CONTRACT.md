# Phase 7A — Admin Reports & Analytics API Contract

All endpoints are versioned under `/api/v1` and require a valid access token.

## Authorization

- **Role required: `ADMIN` only.** Unlike `admin/orders` (which also allows `CASHIER`), every
  endpoint below is restricted to `ADMIN` via `@Roles('ADMIN')` + the existing global
  `JwtAccessGuard` → `RolesGuard` pipeline.
- `CASHIER` → `403 Forbidden` (`{ "code": "FORBIDDEN" }`).
- `CUSTOMER` → `403 Forbidden`.
- No/invalid token → `401 Unauthorized`.

## Date / timezone semantics

All endpoints below accept optional `from`/`to` ISO date query params, resolved by the shared
helper `src/modules/reports/date-range.util.ts`:

- **UTC-explicit, never server-local.** All parsing/boundary math uses `Date.UTC(...)` — the
  server's local timezone is never consulted.
- **`from`** is the start of the given instant. A date-only value (`"2026-07-01"`) resolves to
  `2026-07-01T00:00:00.000Z`.
- **`to` is INCLUSIVE.** A date-only value resolves to the end of that UTC day
  (`2026-07-28T23:59:59.999Z`), so `to=2026-07-28` includes every order created during July 28th
  UTC. A full ISO datetime is used as-is (still inclusive, via `lte`).
- **Omitting both `from` and `to`** means "all time" (no `createdAt` filter) for `overview`,
  `orders`, and `top-items`.
- **`sales` is the one exception**: because it must return a bounded, gap-filled series, an
  omitted `from`/`to` defaults to a **trailing 30-UTC-day window ending "today" (UTC)**. If only
  one side is given, the other is filled in relative to it (e.g. only `from` given → `to`
  defaults to end of today UTC; only `to` given → `from` defaults to 29 days before `to`'s day).
- **Validation**: `from` must not be after `to` → `400 Bad Request`,
  `code: "INVALID_DATE_RANGE"`. Unparseable dates → same error/code.
- **Range-size guard** (sales only): a `groupBy=day` request spanning more than ~1000 days (or
  the equivalent for `week`/`month`) is rejected with `400`, `code: "DATE_RANGE_TOO_LARGE"`, to
  avoid generating an unbounded, mostly-empty bucket array.

## 1. Overview

`GET /api/v1/admin/reports/overview?from=&to=`

Response:

```json
{
  "totalRevenue": 1250.5,
  "totalOrders": 42,
  "deliveredOrders": 30,
  "cancelledOrders": 3,
  "averageOrderValue": 41.68,
  "activeCustomers": 120,
  "newCustomers": 5,
  "deliveryOrders": 25,
  "pickupOrders": 17,
  "cashOrders": 28,
  "cardOrders": 14
}
```

Calculation rules:

- `totalRevenue` / `averageOrderValue` are computed from **`DELIVERED` orders only**, within the
  requested `createdAt` window. `averageOrderValue = totalRevenue / deliveredOrders`, returned as
  `0` when `deliveredOrders === 0` (no division by zero).
- `totalOrders` counts **all statuses** within the window.
- `deliveryOrders`/`pickupOrders` and `cashOrders`/`cardOrders` count **all statuses** within the
  window, grouped by the real `DeliveryMethod`/`PaymentMethod` enum values (`DELIVERY`, `PICKUP`,
  `CASH`, `CARD`). `WALLET` exists as a payment method enum value but has no dedicated field in
  this response (see the `orders` breakdown endpoint for the full enum coverage).
- `activeCustomers` is a **global snapshot**, not date-scoped: count of `User` rows with
  `role = CUSTOMER` and `deletedAt = null` (mirrors the `isActive` semantics already used by
  `CustomersService`).
- `newCustomers` **is** date-scoped: count of `User` rows with `role = CUSTOMER` and `createdAt`
  inside the window, evaluated against the user's **current** role — so a user registered as
  CUSTOMER and later promoted to ADMIN/CASHIER before the report runs is correctly excluded.
- ADMIN and CASHIER users are excluded from both customer metrics.

## 2. Sales timeline

`GET /api/v1/admin/reports/sales?from=&to=&groupBy=day|week|month`

Default `groupBy=day`. Response is a plain array, one entry per period, **sorted ascending**,
**gaps filled with zero values**:

```json
[
  { "period": "2026-07-28", "revenue": 320.0, "orderCount": 8, "deliveredOrderCount": 6 }
]
```

- `revenue`/`deliveredOrderCount` use `DELIVERED` orders only; `orderCount` includes all statuses.
- Bucketing is done in-app (not via SQL `date_trunc`) after fetching orders in the resolved range,
  all boundaries computed in UTC:
  - `day` → `"YYYY-MM-DD"`, midnight-to-midnight UTC.
  - `week` → `"YYYY-MM-DD"`, keyed by the **UTC Monday** starting that week (ISO-style weeks, not
    calendar-locale weeks).
  - `month` → `"YYYY-MM"`, calendar month UTC.
- See "Date / timezone semantics" above for the default 30-day window when `from`/`to` are
  omitted, and the range-size guard.

## 3. Order breakdown

`GET /api/v1/admin/reports/orders?from=&to=`

```json
{
  "byStatus": [{ "status": "PENDING", "count": 0 }],
  "byFulfillmentType": [{ "type": "DELIVERY", "count": 0 }],
  "byPaymentMethod": [{ "method": "CASH", "count": 0 }]
}
```

- Every known enum value is always present (6 `OrderStatus`, 2 `DeliveryMethod`, 3
  `PaymentMethod` including `WALLET`), with `count: 0` when there is no matching data — no enum
  value is ever omitted.
- Counts reflect **all statuses** within the window (this endpoint is a breakdown, not a
  delivered-only revenue view).

## 4. Top-selling items

`GET /api/v1/admin/reports/top-items?from=&to=&limit=10`

```json
[
  {
    "menuItemId": "uuid",
    "nameAr": "...",
    "nameEn": "...",
    "quantitySold": 12,
    "revenue": 480.0
  }
]
```

- Counts **`DELIVERED` orders only**.
- Aggregated via `OrderItem.groupBy(['menuItemId'])` with `_sum: { quantity, lineTotal }` —
  `quantity` and `lineTotal` are the actual order-line snapshot/price fields on `OrderItem`
  (`unitPrice`/`lineTotal` are computed once at checkout and never recalculated from the live
  catalog). `menuItemId` rows are excluded if null (soft-reference field, always populated at
  order-creation time today, but nullable for forward-compat).
- `nameAr`/`nameEn` come from the **most recent `OrderItem` snapshot** for that `menuItemId`
  (`nameArSnapshot`/`nameEnSnapshot`), not a live `MenuItem` join — so a renamed or deleted catalog
  item still reports sensibly.
- Sorted by `quantitySold` descending, then `revenue` descending (tie-break).
- `limit`: optional, default `10`, min `1`, max `50` — out-of-range values are rejected by
  `class-validator` with `400`.

## Error codes introduced

| Code                  | Status | Meaning                                          |
| --------------------- | ------ | ------------------------------------------------- |
| `INVALID_DATE_RANGE`  | 400    | `from` is after `to`, or a date failed to parse.  |
| `DATE_RANGE_TOO_LARGE`| 400    | Sales timeline range would generate too many periods (>~1000). |

Both flow through the existing `AllExceptionsFilter` canonical error envelope.

## Database / migration changes

- Added `@@index([menuItemId])` to `OrderItem` (migration
  `20260728124759_add_order_item_menu_item_id_index`) — supports the `top-items` `groupBy` query,
  which was previously unindexed on that column (only `orderId` was indexed).
- No other schema changes. Existing indexes reused: `Order.createdAt`, `Order.status`,
  `User.role`.

## Flutter integration notes

- Do **not** recompute any of these numbers client-side — this phase's entire purpose is to move
  aggregation server-side. Treat all four endpoints as read-only report views.
- `sales` always returns a contiguous, gap-filled array in ascending period order — safe to feed
  directly into a chart without client-side date-bucketing.
- `period` strings are plain UTC-derived date strings (`"YYYY-MM-DD"` or `"YYYY-MM"|`) — format
  them for display using the device locale, but do not reinterpret them as local-time instants.
- `overview.averageOrderValue` and `sales[].revenue` are `0`, not `null`, when there's no
  delivered-order data in range — no null-check needed before rendering.
- Money fields are plain JS `number` (already `.toNumber()`'d server-side from `Prisma.Decimal`),
  consistent with every other money field in this API (`Order.totalAmount`, etc.).
- `admin/reports/orders` always returns every enum value (zero-filled) — safe to index a fixed-
  size chart/legend by enum value without existence checks.
