# Phase 6 — Customer Management API Contract

All routes are `@Roles('ADMIN')` only. `CASHIER` (and any other non-`ADMIN`
role) gets `403 FORBIDDEN` on every `/admin/customers` route, same
`RolesGuard` mechanism as the rest of `/admin/*`.

## Endpoints

### `GET /api/v1/admin/customers`

Lists `CUSTOMER`-role accounts only — `ADMIN`/`CASHIER` accounts are excluded
by `WHERE role = 'CUSTOMER'`, never returned here.

**Query parameters** (`ListCustomersDto`):

| Param | Type | Notes |
|---|---|---|
| `q` | string, ≤100 chars | free-text, matches name / email / phone (case-insensitive `contains`) |
| `isActive` | boolean | `true` → `deletedAt IS NULL`, `false` → `deletedAt IS NOT NULL` |
| `page` | int ≥1, default 1 | |
| `limit` | int 1-100, default 20 | |

**Pagination response shape**: a plain JSON array (`CustomerListItemDto[]`),
same convention as the existing `GET /admin/orders` — no envelope, no
`total`/`meta` object (this codebase has no pagination-envelope convention
anywhere; skip/take is applied but no other list endpoint returns a count
either).

**List item (`CustomerListItemDto`)**:
```json
{
  "id": "uuid",
  "name": "string",
  "email": "string | null",
  "phone": "string | null",
  "isGuest": "boolean",
  "isActive": "boolean",
  "createdAt": "ISO 8601",
  "orderCount": "number",
  "totalSpent": "number"
}
```

### `GET /api/v1/admin/customers/:id`

Returns `CustomerDetailDto` = `CustomerListItemDto` + `recentOrders` (most
recent 10, newest first, concise fields only):

```json
{
  ...CustomerListItemDto fields,
  "recentOrders": [
    {
      "id": "uuid",
      "orderNumber": "string",
      "status": "pending|confirmed|preparing|outForDelivery|delivered|cancelled",
      "totalAmount": "number",
      "paymentMethod": "cash|card|wallet",
      "fulfillmentType": "delivery|pickup",
      "createdAt": "ISO 8601"
    }
  ]
}
```

Errors: `404 CUSTOMER_NOT_FOUND` if `id` doesn't exist or isn't a `CUSTOMER`.

### `PATCH /api/v1/admin/customers/:id/status`

Request (`UpdateCustomerStatusDto`):
```json
{ "isActive": true }
```

Response: `CustomerDetailDto` (the updated customer, same shape as the GET-by-id above).

Errors: `404 CUSTOMER_NOT_FOUND` if `id` doesn't exist or isn't a `CUSTOMER`
(an `ADMIN`/`CASHIER` id 404s here too — this endpoint can never touch a
staff account).

## Active / disabled behavior

Reuses the existing `User.deletedAt` soft-delete column — the same mechanism
already used for cashier deactivation (Phase 5) and already enforced
everywhere in the auth stack. No new column, no new logic:

- `isActive: false` → sets `deletedAt = now()`.
- `isActive: true` → clears `deletedAt` (sets `null`).
- `AuthService.authenticate` already filters `WHERE deletedAt IS NULL`, so a
  disabled customer gets `401 INVALID_CREDENTIALS` on login.
- `TokenService.rotateRefreshToken` already rejects any user with a non-null
  `deletedAt`, so a disabled customer's refresh token stops working
  (`401 INVALID_REFRESH_TOKEN`).
- Already-issued access tokens remain valid until their normal short TTL
  expiry — unchanged, pre-existing behavior, not modified by this phase.

## totalSpent calculation rule

`totalSpent` = sum of `Order.totalAmount` for orders with `status = 'DELIVERED'`
only (this backend has no separate "completed" status — `DELIVERED` is the
terminal successful state, and it's the same status that already gates
loyalty-points earning in `LoyaltyService`). Orders in any other status
(including `CANCELLED`) are excluded from spend.

`orderCount` = count of **all** orders for the customer, any status —
distinct from `totalSpent`, which is DELIVERED-only.

Computed server-side via two batched `Prisma.order.groupBy` queries (count +
DELIVERED sum) per page of customers — never computed in Flutter.

## Error codes introduced

| Code | HTTP | Where |
|---|---|---|
| `CUSTOMER_NOT_FOUND` | 404 | `GET /admin/customers/:id`, `PATCH /admin/customers/:id/status` |

No other new error codes — role/auth failures reuse the existing `FORBIDDEN`,
`UNAUTHORIZED`, `INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN` codes.
