# 10 — Frontend Compatibility Checklist

Every endpoint that exists in the backend today, cross-referenced against this doc set. ✔ = covered / applies.
`—` = not applicable to that endpoint. "Invalidate" = which client-side provider(s) should be invalidated or
locally updated after a successful call to this endpoint (per `09_FRONTEND_INTEGRATION.md`).

## Auth

| Endpoint | Exists | DTO doc'd | Auth doc'd | Invalidate |
|---|---|---|---|---|
| `POST /auth/register` | ✔ | ✔ | ✔ Public | auth provider |
| `POST /auth/signup` (alias) | ✔ | ✔ | ✔ Public | auth provider |
| `POST /auth/login` | ✔ | ✔ | ✔ Public | auth provider |
| `POST /admin/auth/login` | ✔ | ✔ | ✔ Public | auth provider |
| `POST /auth/admin/login` (alias) | ✔ | ✔ | ✔ Public | auth provider |
| `POST /auth/refresh` | ✔ | ✔ | ✔ Public | auth provider (tokens only) |
| `POST /auth/logout` | ✔ | ✔ | ✔ any role | auth + cart + orders + favorites + addresses + loyalty providers (full clear) |
| `POST /auth/logout-all` | ✔ | ✔ | ✔ any role | same as above |
| `POST /auth/guest` | ✔ | ✔ | ✔ Public | auth provider |

## Users

| Endpoint | Exists | DTO doc'd | Auth doc'd | Invalidate |
|---|---|---|---|---|
| `GET /users/me` | ✔ | ✔ | ✔ any role | user sub-state of auth provider |
| `PATCH /users/me` | ✔ | ✔ | ✔ any role | user sub-state of auth provider (use response directly) |

## Catalog — public

| Endpoint | Exists | DTO doc'd | Auth doc'd | Invalidate |
|---|---|---|---|---|
| `GET /categories` | ✔ | ✔ | ✔ Public | — (read-only for customer app) |
| `GET /categories/:id` | ✔ | ✔ | ✔ Public | — |
| `GET /menu` | ✔ | ✔ | ✔ Public | — |
| `GET /menu/search` | ✔ | ✔ | ✔ Public | — |
| `GET /menu/items/:id` | ✔ | ✔ | ✔ Public | — |
| `GET /home/featured` | ✔ | ✔ | ✔ Public | — |

**Customer cache**: safe to cache 5-15 min, stale-while-revalidate on app start (see `09`).

## Catalog — admin

| Endpoint | Exists | DTO doc'd | Auth doc'd | Upload-related | Invalidate |
|---|---|---|---|---|---|
| `GET /admin/categories` | ✔ | ✔ | ✔ ADMIN | — | — |
| `POST /admin/categories` | ✔ | ✔ | ✔ ADMIN | iconUrl accepts uploaded URL | admin categories list; public categories list if shared process |
| `PUT /admin/categories/:id` | ✔ | ✔ | ✔ ADMIN | iconUrl accepts uploaded URL | same |
| `DELETE /admin/categories/:id` | ✔ | ✔ | ✔ ADMIN | — | same |
| `GET /admin/menu` | ✔ | ✔ | ✔ ADMIN | — | — |
| `POST /admin/menu/items` | ✔ | ✔ | ✔ ADMIN | ✔ imageUrl from `/admin/uploads/image` | admin menu list; public menu/featured lists if shared process |
| `PUT /admin/menu/items/:id` | ✔ | ✔ | ✔ ADMIN | ✔ | same |
| `PATCH /admin/menu/items/:id/availability` | ✔ | ✔ | ✔ ADMIN | — | same |
| `DELETE /admin/menu/items/:id` | ✔ | ✔ | ✔ ADMIN | — | same |

**Admin cache**: do **not** cache across sessions — refetch on screen entry (this is the editing surface; see `09` for the root-cause note on the "item doesn't appear" bug).

## Settings

| Endpoint | Exists | DTO doc'd | Auth doc'd | Invalidate |
|---|---|---|---|---|
| `GET /settings` | ✔ | ✔ | ✔ Public | — |
| `GET /admin/settings` | ✔ | ✔ | ✔ ADMIN | — |
| `PUT /admin/settings` | ✔ | ✔ | ✔ ADMIN | settings provider (both admin and public-facing, if shared process) |

## Cart

| Endpoint | Exists | DTO doc'd | Auth doc'd | Invalidate |
|---|---|---|---|---|
| `GET /cart` | ✔ | ✔ | ✔ any role | — |
| `POST /cart/items` | ✔ | ✔ | ✔ any role | cart provider (use response) |
| `PUT /cart/items/:id` | ✔ | ✔ | ✔ any role | cart provider (use response) |
| `DELETE /cart/items/:id` | ✔ | ✔ | ✔ any role | cart provider (use response) |
| `POST /cart/apply-promo` | ✔ | ✔ | ✔ any role | cart provider (use response) |
| `DELETE /cart/promo` | ✔ | ✔ | ✔ any role | cart provider (use response) |
| `DELETE /cart` | ✔ | ✔ | ✔ any role | cart provider (use response) |

**Customer cache**: session-only, always live — see `09`.

## Promos

| Endpoint | Exists | DTO doc'd | Auth doc'd | Invalidate |
|---|---|---|---|---|
| `POST /promos/validate` | ✔ | ✔ | ✔ any role | — (does not mutate cart) |
| `GET /admin/promos` | ✔ | ✔ | ✔ ADMIN | — |
| `POST /admin/promos` | ✔ | ✔ | ✔ ADMIN | admin promos list |
| `PUT /admin/promos/:id` | ✔ | ✔ | ✔ ADMIN | admin promos list |
| `DELETE /admin/promos/:id` | ✔ | ✔ | ✔ ADMIN | admin promos list |

## Checkout & Orders

| Endpoint | Exists | DTO doc'd | Auth doc'd | Invalidate |
|---|---|---|---|---|
| `POST /checkout` | ✔ | ✔ | ✔ CUSTOMER | cart provider (reset to empty) + orders list provider + loyalty account provider (when `loyaltyRedemption` is present in the response) |
| `POST /orders` (alias) | ✔ | ✔ | ✔ CUSTOMER | same |
| `GET /orders` | ✔ | ✔ | ✔ any role | — |
| `GET /orders/:id` | ✔ | ✔ | ✔ any role | — |
| `GET /orders/:id/status` | ✔ | ✔ | ✔ any role | — (poll or refresh on push-notification tap) |

**Customer cache should refresh**: order list on successful checkout; order-status on receiving the matching push notification (`route: /orders/tracking/<id>`).

## Admin Orders

| Endpoint | Exists | DTO doc'd | Auth doc'd | Invalidate |
|---|---|---|---|---|
| `GET /admin/orders` | ✔ | ✔ | ✔ ADMIN | — |
| `GET /admin/orders/:id` | ✔ | ✔ | ✔ ADMIN | — |
| `PATCH /admin/orders/:id/status` | ✔ | ✔ | ✔ ADMIN | admin order detail (use response) + admin orders list |

**Admin cache should refresh**: orders list after any status change; enforce the legal-transition table client-side (see `05`) before even attempting the call.

## Payments

| Endpoint | Exists | DTO doc'd | Auth doc'd | Invalidate |
|---|---|---|---|---|
| `POST /payments/intent` | ✔ | ✔ | ✔ CUSTOMER | — (CARD/WALLET always `501` — see `01`/`09`) |
| `GET /payments/:id` | ✔ | ✔ | ✔ any role | — |
| `POST /payments/webhook` | ✔ | ✔ | ✔ Public | not frontend-relevant (gateway→server only) |

## Devices

| Endpoint | Exists | DTO doc'd | Auth doc'd | Invalidate |
|---|---|---|---|---|
| `POST /devices/register` | ✔ | ✔ | ✔ any role | — (no UI reads this back) |
| `PUT /devices/token` | ✔ | ✔ | ✔ any role | — |
| `DELETE /devices/token` | ✔ | ✔ | ✔ any role | — |

## Addresses

| Endpoint | Exists | DTO doc'd | Auth doc'd | Invalidate |
|---|---|---|---|---|
| `GET /me/addresses` | ✔ | ✔ | ✔ any role | — |
| `POST /me/addresses` | ✔ | ✔ | ✔ any role | addresses provider |
| `PUT /me/addresses/:id` | ✔ | ✔ | ✔ any role | addresses provider |
| `DELETE /me/addresses/:id` | ✔ | ✔ | ✔ any role | addresses provider |
| `PATCH /me/addresses/:id/default` | ✔ | ✔ | ✔ any role | addresses provider (invalidate — every other row's `isDefault` also changed server-side) |

## Favorites

| Endpoint | Exists | DTO doc'd | Auth doc'd | Invalidate |
|---|---|---|---|---|
| `GET /me/favorites` | ✔ | ✔ | ✔ CUSTOMER | — |
| `POST /me/favorites` | ✔ | ✔ | ✔ CUSTOMER | favorites provider (use response — full list returned) |
| `DELETE /me/favorites/:menuItemId` | ✔ | ✔ | ✔ CUSTOMER | favorites provider (204, no body — refetch or locally filter) |

## Loyalty

| Endpoint | Exists | DTO doc'd | Auth doc'd | Invalidate |
|---|---|---|---|---|
| `GET /me/loyalty` | ✔ | ✔ | ✔ CUSTOMER, non-guest | — |
| `GET /me/loyalty/transactions` | ✔ | ✔ | ✔ CUSTOMER, non-guest | — |
| `POST /me/loyalty/redeem` — ⚠️ legacy, prefer `redeemRewardId` at checkout | ✔ | ✔ | ✔ CUSTOMER, non-guest | loyalty account provider (use response) + loyalty transactions provider (invalidate) |

## Admin Notifications

| Endpoint | Exists | DTO doc'd | Auth doc'd | Upload-related | Invalidate |
|---|---|---|---|---|---|
| `POST /admin/notifications/send` | ✔ | ✔ | ✔ ADMIN | imageUrl accepts uploaded URL | admin campaigns list |
| `POST /admin/notifications/schedule` | ✔ | ✔ | ✔ ADMIN | imageUrl accepts uploaded URL | admin campaigns list |
| `GET /admin/notifications/campaigns` | ✔ | ✔ | ✔ ADMIN | — | — |
| `DELETE /admin/notifications/campaigns/:id` | ✔ | ✔ | ✔ ADMIN | — | admin campaigns list |

## Uploads

| Endpoint | Exists | DTO doc'd | Auth doc'd | Upload doc'd | Invalidate |
|---|---|---|---|---|---|
| `POST /admin/uploads/image` | ✔ | ✔ | ✔ ADMIN | ✔ (`07_UPLOAD_SYSTEM.md`) | — (result is consumed by the caller's own form state, see `09`) |

## Health

| Endpoint | Exists | DTO doc'd | Auth doc'd | Invalidate |
|---|---|---|---|---|
| `GET /health` | ✔ | ✔ | ✔ Public | — (not app-relevant, orchestrator use) |
| `GET /health/ready` | ✔ | ✔ | ✔ Public | — |

---

## Known gaps for the frontend to design around (not bugs — documented current behavior)

- No `DELETE /admin/uploads/*` — orphaned uploaded files are never cleaned up.
- No image field on `PromoDto` — promos cannot carry an image today.
- No `GET /me/loyalty/rewards` — the redeemable rewards catalog is hardcoded and must be duplicated client-side or requested as a future backend addition.
- No `addressId` support in `CheckoutDto` — saved addresses must be copied inline into every checkout request.
- `GET /orders/:id` and other order read endpoints do not surface `loyaltyRedemption` for a past order — it's only populated on the checkout response itself (and its idempotent retries). Fetch `GET /me/loyalty/transactions` and filter by `orderId` if a past order's redemption detail is needed elsewhere in the UI.
- (Resolved, noted for history) Loyalty redemption used to be entirely disconnected from checkout, meaning points could be spent via `POST /me/loyalty/redeem` with no guarantee the customer went on to complete an order. `CheckoutDto.redeemRewardId` now provides an atomic alternative — new checkout UI should use it instead of the standalone endpoint.
- `CARD`/`WALLET` payment methods are selectable but non-functional (`501` on intent creation) — hide or clearly gate them in UI.
- No pagination metadata (total/hasMore) anywhere — infinite-scroll UIs must infer "no more pages" from getting back fewer items than `limit`, not from a total count.
- `Order.estimatedDeliveryTime`, `Order.cancelledAt`, `Order.cancelReason`, `NotificationCampaign.openedCount`/`clickRate` all exist in API responses but are **always** `null`/`0` — don't build UI that depends on real values ever appearing there without a backend change first.
