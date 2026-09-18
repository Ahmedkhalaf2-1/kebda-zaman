# Phase 5 — Cashier Staff API Contract

## Role value

`UserRole.CASHIER` added to the existing `UserRole` enum (`CUSTOMER`, `ADMIN`, `CASHIER`).

## Login behavior

No new login system. Cashiers authenticate through the existing customer/staff
login endpoint:

```
POST /api/v1/auth/login
Body: { "email": string, "password": string }
```

This endpoint (`AuthService.login` → `authenticate({ requireAdmin: false })`)
already accepts any active user regardless of role, so no code change was
needed for cashier login itself.

`POST /api/v1/admin/auth/login` and its alias `POST /api/v1/auth/admin/login`
remain **ADMIN-only** (`requireAdmin: true`) — a cashier account is rejected
there with `403 NOT_ADMIN`.

**Disabled cashier accounts cannot log in or refresh.** Deactivation reuses
the existing `User.deletedAt` soft-delete column (no new column):

- `AuthService.authenticate` filters `WHERE deletedAt IS NULL` — a deactivated
  cashier gets `401 INVALID_CREDENTIALS` on login.
- `TokenService.rotateRefreshToken` already rejects any user with a non-null
  `deletedAt` — a deactivated cashier's refresh token stops working
  (`401 INVALID_REFRESH_TOKEN`).
- Already-issued **access tokens** remain valid until their normal short TTL
  expiry (same behavior as every other role today — no new revocation
  mechanism was introduced, per the "no large redesign" constraint).

## Staff endpoints

All routes below require an authenticated `ADMIN` (`@Roles('ADMIN')`); any
other role, including `CASHIER`, gets `403 FORBIDDEN`.

### `GET /api/v1/admin/staff`

Lists all cashier accounts (active and deactivated), newest first.

Response: `StaffResponseDto[]`

### `POST /api/v1/admin/staff`

Creates a new cashier account.

Request (`CreateStaffDto`):
```json
{
  "name": "string (2-100 chars)",
  "email": "string (valid email, ≤255 chars)",
  "password": "string (8-72 chars)",
  "phone": "string (optional, ≤30 chars)"
}
```

Response: `StaffResponseDto` (201)

Errors:
- `409 EMAIL_ALREADY_EXISTS` — email already used by another active account.

### `PATCH /api/v1/admin/staff/:id`

Partially updates a cashier account. Only supplied fields are changed.

Request (`UpdateStaffDto`, all fields optional):
```json
{
  "name": "string (2-100 chars)",
  "email": "string (valid email, ≤255 chars)",
  "phone": "string (≤30 chars)",
  "isActive": "boolean",
  "password": "string (8-72 chars)"
}
```

- `isActive: false` deactivates the account (sets `deletedAt`); the cashier
  is immediately blocked from login/refresh.
- `isActive: true` reactivates a previously deactivated account (`deletedAt`
  cleared).
- `password` triggers a normal Argon2id re-hash via the existing
  `PasswordService` — no separate reset-token flow.

Response: `StaffResponseDto` (200)

Errors:
- `404 STAFF_NOT_FOUND` — `id` does not exist or does not belong to a
  `CASHIER` account.
- `409 EMAIL_ALREADY_EXISTS` — new email already used by another active
  account.

### Response DTO — `StaffResponseDto`

```ts
{
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;   // true when deletedAt is null
  createdAt: string;   // ISO 8601
}
```

## Cashier order permissions

`AdminOrdersController` is now `@Roles('ADMIN', 'CASHIER')`. Status-transition
rules in `OrdersService.updateOrderStatus` are unchanged.

- `GET /api/v1/admin/orders` — list orders
- `GET /api/v1/admin/orders/:id` — order detail
- `PATCH /api/v1/admin/orders/:id/status` — update order status

Both `ADMIN` and `CASHIER` may call all three; behavior and validation are
identical to the existing `ADMIN` behavior.

## Routes forbidden to cashier

All still gated `@Roles('ADMIN')` only — unchanged, `CASHIER` gets
`403 FORBIDDEN`:

- `GET/POST/PUT/DELETE /api/v1/admin/categories`
- `GET/POST/PUT/DELETE /api/v1/admin/menu*`
- `GET/POST/PUT/DELETE /api/v1/admin/promos`
- `GET/PATCH /api/v1/admin/settings`
- `POST /api/v1/admin/notifications*` (campaigns)
- `GET/POST/PATCH /api/v1/admin/staff` (staff management itself)
- `GET/PATCH /api/v1/admin/notifications` (admin notification center)
- `POST /api/v1/admin/uploads*`
- `POST /api/v1/admin/auth/login`, `POST /api/v1/auth/admin/login`

## Error codes introduced

| Code | HTTP | Where |
|---|---|---|
| `EMAIL_ALREADY_EXISTS` | 409 | `POST /admin/staff`, `PATCH /admin/staff/:id` |
| `STAFF_NOT_FOUND` | 404 | `PATCH /admin/staff/:id` |

No new error codes were introduced for login/orders — existing codes
(`INVALID_CREDENTIALS`, `NOT_ADMIN`, `FORBIDDEN`, `INVALID_REFRESH_TOKEN`,
etc.) are reused unchanged.

## Migration

`prisma/migrations/20260728032802_add_cashier_role/migration.sql`

```sql
-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'CASHIER';
```

Purely additive — existing `CUSTOMER` and `ADMIN` rows are untouched.
