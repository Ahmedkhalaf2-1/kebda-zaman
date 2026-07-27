# 09 — Frontend Integration Guide

This document translates every backend feature into a concrete Flutter integration pattern:
**Repository → Provider → Request → Response → State update → Caching → Invalidation.**

It assumes a standard Repository + Riverpod (or any Provider-based state layer — the pattern applies equally to
Bloc/Cubit with "provider" read as "cubit/bloc") architecture, since that's the architecture implied by the bug
report that prompted this document set (a menu item not appearing after creation until manual refresh — a
classic missing-invalidation symptom). **This is architectural guidance, not a description of existing Flutter
code** — this backend repo has no visibility into the actual Flutter project.

General rules that apply everywhere below, stated once instead of repeated per section:

- **Never trust a locally-computed price.** Every money figure (unit price, line total, subtotal, tax, delivery
  fee, discount, total) must come from the server response. The backend recomputes all of this from scratch on
  every cart/checkout call specifically so the client cannot desync from it — mirror that by never caching or
  locally deriving a price across a mutation.
- **Every mutation response already contains the fresh state.** `POST/PUT/DELETE /cart/*` all return the full
  updated `CartResponseDto`; `POST /me/favorites` returns the full updated favorites array. Prefer using the
  **mutation's own response** to update local state directly over triggering a separate refetch — it's already
  in the response, and using it avoids a duplicate request and a network round-trip window where the UI shows
  stale data.
- **List endpoints return bare arrays**, never `{ data, total }`. Don't build pagination UI expecting a total
  count — none exists anywhere in this API.

---

## Auth (`auth`, `users`)

- **Repository**: `AuthRepository` wrapping `POST /auth/register|login|guest|refresh|logout|logout-all`, `GET/PATCH /users/me`.
- **Provider**: an app-wide auth state provider holding `{ user, accessToken, refreshToken, isAuthenticated }`, exposed globally (not scoped to a screen) since almost every other provider depends on knowing the current user/token.
- **Request/Response**: see `02_API_REFERENCE.md` / `03_DTO_REFERENCE.md` for exact shapes.
- **State update**: on login/register/guest success, write the full `AuthResult` into the auth provider and persist tokens to secure storage. On `/users/me` PATCH, update just the `user` sub-state.
- **Caching**: tokens must be persisted (secure storage), not just in-memory — survive app restarts. The `user` object itself can be treated as short-lived cache, refreshed via `GET /users/me` on app resume.
- **Invalidation**: on `logout`/`logout-all` success, clear the auth provider **and every other provider that holds user-scoped data** (cart, orders, favorites, addresses, loyalty) — none of that data is valid for the next session, including a subsequent guest session. On a `401` that survives a refresh attempt, do the same clear-and-redirect-to-login.

## Catalog (`catalog`) — public browsing

- **Repository**: `CatalogRepository` wrapping `GET /categories`, `GET /categories/:id`, `GET /menu`, `GET /menu/search`, `GET /menu/items/:id`, `GET /home/featured`.
- **Provider**: `categoriesProvider` (list), `menuItemsProvider(categoryId, page)` (paginated per-category), `menuSearchProvider(query)`, `featuredProvider`, `menuItemProvider(id)` (detail).
- **State update**: straightforward — these are read-only for the customer app; store the response array/object directly.
- **Caching**: this data changes only when an admin edits the catalog — safe to cache aggressively (e.g. 5-15 minutes) and safe to show stale-while-revalidate on app start. Not real-time-critical.
- **Invalidation**: the customer app itself never invalidates this (it doesn't mutate catalog data) — but see "Admin Catalog" below for the write side, which **is** where invalidation actually matters.

## Admin Catalog (`catalog` admin routes) — **this is the section relevant to the reported "item doesn't appear after creation" bug**

- **Repository**: `AdminCatalogRepository` wrapping `GET /admin/categories`, `POST/PUT/DELETE /admin/categories*`, `GET /admin/menu`, `POST/PUT/PATCH/DELETE /admin/menu/items*`.
- **Provider**: `adminMenuItemsProvider(categoryId?, q?)`, `adminCategoriesProvider`.
- **Request**: on create, `POST /admin/menu/items` with `MenuItemDto` — remember `imageUrl` is optional/nullable, only send it if an upload actually completed (see `07_UPLOAD_SYSTEM.md`).
- **Response**: the create/update call returns the **full created/updated `AdminMenuItemResponseDto`** — this is the fresh row, already shaped exactly like a list entry.
- **State update (root cause of the "doesn't appear until refresh" symptom)**: a `POST /admin/menu/items` (or any create/update/delete) call must do one of:
  1. **Preferred — optimistic local update**: on success, take the response object and prepend/replace it in the `adminMenuItemsProvider` list state directly (no extra network call). This is instant and avoids a duplicate request.
  2. **Acceptable — explicit invalidation**: call `ref.invalidate(adminMenuItemsProvider)` (or the Bloc/Cubit equivalent: dispatch a refetch event) immediately after the create/update/delete call resolves, so the provider is marked stale and Riverpod refetches on next read/rebuild.
  - **What causes the reported bug**: if the create call's `.then()`/`await` only updates a "success" flag or shows a snackbar, but never touches the list provider's state or calls `ref.invalidate(...)`, the already-fetched (now-stale) provider keeps rendering its old cached list until something else happens to trigger a rebuild (e.g. a manual pull-to-refresh, which re-runs the provider from scratch and finally shows the true DB state). The fix is always one of the two options above — pick optimistic update for the snappiest UX, invalidation for the simplest/most robust one.
- **Caching**: admin lists should **not** be cached across app sessions — always refetch on screen entry, since this is the editing surface itself (staleness here directly causes the reported bug class).
- **Invalidation**: any admin mutation to a menu item/category should invalidate **both** the admin list provider **and** the public-facing `categoriesProvider`/`menuItemsProvider`/`featuredProvider` if the admin app and customer app share a process (unlikely for two separate apps, but if the admin panel is a mode within the same Flutter app, don't forget the public-facing providers are now stale too).

## Image upload (`uploads`) — used from the admin menu-item form

- **Repository**: `UploadsRepository` wrapping `POST /admin/uploads/image` (multipart).
- **Provider**: typically not a cached "provider" at all — this is a one-shot action, best modeled as a method call from the form's controller/notifier, not a `FutureProvider`.
- **Request**: build a `multipart/form-data` request with the picked file under field name `file` exactly (see `07_UPLOAD_SYSTEM.md`).
- **Response**: `{ imageUrl }` — a complete, ready-to-use URL.
- **State update**: store the returned `imageUrl` string in the **form's local state** (not a global provider) — it only becomes real data once the form is submitted via `POST/PUT /admin/menu/items`.
- **Flow (this is the fix for the reported "uploaded image not shown after save" bug, if the endpoint wasn't being called at all)**:
  1. User picks an image → show local preview from the picked file's bytes/path (no network call yet).
  2. On "Save" tap: **first** `await` the upload call, get `imageUrl` back.
  3. **Then** include that `imageUrl` in the `POST/PUT /admin/menu/items` body.
  4. Only show the item as saved once step 3's response comes back (which will echo the same `imageUrl`) — use that response to update the list (see "Admin Catalog" above), not the locally-picked file, so the rendered image is the real server-stored one (correct for cache-busting, consistent across app restarts, etc.).
- **Caching**: the resulting `imageUrl` is a permanent, unique URL (UUID-named file, never overwritten) — safe for Flutter's standard image cache (`cached_network_image` or similar) to cache indefinitely; no cache-busting query param is ever needed since the filename itself never gets reused for different content.

## Settings (`settings`)

- **Repository**: `SettingsRepository` wrapping `GET /settings` (customer), `GET/PUT /admin/settings` (admin).
- **Provider**: `restaurantSettingsProvider` — read by cart/checkout screens to display delivery fee, min order, maintenance-mode banner.
- **Caching**: safe to cache for the app session; refetch on app start. Consider a short polling interval (e.g. every few minutes) or refetch on cart screen entry specifically to catch `isMaintenanceMode` toggling live.
- **Invalidation**: after an admin `PUT /admin/settings` succeeds, invalidate `restaurantSettingsProvider` so the admin's own settings screen (and, if shared process, the customer-facing one) reflects the change immediately — same optimistic-update-or-invalidate rule as Admin Catalog.

## Cart (`cart`)

- **Repository**: `CartRepository` wrapping `GET /cart`, `POST/PUT/DELETE /cart/items*`, `POST/DELETE .../apply-promo` & `/promo`, `DELETE /cart`.
- **Provider**: a single `cartProvider` holding the current `CartResponseDto`.
- **Request/Response**: every single cart mutation endpoint (add/update/remove item, apply/remove promo, clear) returns the **entire fresh cart** — always use that response to overwrite `cartProvider`'s state directly. There is never a need to follow a cart mutation with a separate `GET /cart` call.
- **State update**: replace the whole `cartProvider` state with the mutation response on every call — do not attempt to patch individual line items locally (the server may have adjusted quantities, dropped a now-unavailable line's price to zero, etc. — trust the response wholesale).
- **Caching**: cart data is per-user and mutation-driven — don't cache across sessions; always fetch fresh on cart-screen entry after login, then keep in memory for the session.
- **Invalidation**: `cartProvider` should be cleared on logout (see Auth section). No cross-provider invalidation needed elsewhere **except**: after a successful checkout (see below), the cart provider must be reset to empty (or refetched — checkout's own response is an `Order`, not a `Cart`, so this is the one case where a `GET /cart` follow-up, or a manual local "set cart to empty," is warranted).

## Promo validation (`promos`)

- **Repository**: same `CartRepository`/a small `PromosRepository` for `POST /promos/validate`.
- **Provider**: typically not cached — a one-shot check triggered by the user typing/submitting a promo code in the cart screen, independent of `cartProvider`.
- **Request/Response**: note `subtotal` in the request body is ignored server-side — don't bother computing/sending it, though sending it does no harm.
- **State update**: this endpoint does **not** apply the promo — show its result (discount preview) in local UI state, then call `POST /cart/apply-promo` (a **separate** call) if the user confirms, which updates `cartProvider` as described above.

## Checkout & Orders (`orders`)

- **Repository**: `OrdersRepository` wrapping `POST /checkout`, `GET /orders`, `GET /orders/:id`, `GET /orders/:id/status`.
- **Provider**: `ordersListProvider` (paginated), `orderDetailProvider(id)`, `orderStatusProvider(id)` (for a tracking screen — poll this one, it's lighter than the full order).
- **Request**: always generate a stable idempotency key once per checkout attempt (see `05_ORDER_LIFECYCLE.md`) and send it as the `Idempotency-Key` header — critical for correctness on flaky mobile networks (prevents double-orders on a retried tap, and now also prevents double-redeeming a loyalty reward on a retried tap). Include `redeemRewardId` XOR `promoCode`, never both — see the Loyalty section above for how to surface that choice in the checkout UI.
- **Response**: `OrderResponseDto` on success, now including an optional `loyaltyRedemption` block when a reward was redeemed.
- **State update**: on successful checkout, (a) clear/reset `cartProvider` to empty, (b) invalidate `ordersListProvider` so the new order appears in "My Orders" without a manual pull-to-refresh (same pattern as the Admin Catalog fix above — this is the customer-side instance of the exact same bug class), (c) navigate to the order confirmation/tracking screen using the response directly (no need to refetch — you already have the full `OrderResponseDto`), (d) if `response.loyaltyRedemption` is non-null, also update/invalidate `loyaltyAccountProvider` (see Loyalty section) so the spent points are immediately reflected wherever the balance is shown.
- **Caching**: order history is reasonably cacheable, but the **tracking screen for an in-progress order should poll** `GET /orders/:id/status` (e.g. every 15-30s) or, better, refetch on receiving the corresponding push notification (see `08_NOTIFICATION_REFERENCE.md` — every status-change push includes `route: "/orders/tracking/<orderId>"`, so wire the app's deep-link handler to invalidate `orderStatusProvider(orderId)` when that route is opened from a notification tap, instead of relying on polling alone).
- **Invalidation**: `ordersListProvider` should invalidate on: successful checkout, and (if the admin app shares state with a customer view somehow) any admin status update — normally not applicable since these are separate apps/users.

## Payments (`payments`)

- **Repository**: `PaymentsRepository` wrapping `POST /payments/intent`, `GET /payments/:id`.
- **Caveat to design around**: only `CASH` works. If the app lets a user pick `CARD`/`WALLET` at checkout, calling `POST /payments/intent` afterward for those methods will always fail with `501`. Either hide those payment methods entirely in the UI, or handle the `PAYMENT_PROVIDER_NOT_CONFIGURED` code explicitly with a "coming soon" message — don't build a silent-retry loop against it.
- **State update**: for cash orders, `createIntent`'s response is mostly informational (`instructions: "Pay with cash upon delivery"`) — no client-side payment SDK interaction is needed at all.

## Devices (`devices`)

- **Repository**: `DevicesRepository` wrapping `POST /devices/register`, `PUT /devices/token`, `DELETE /devices/token`.
- **Provider**: no user-facing provider needed — this is background plumbing, triggered from app lifecycle hooks, not screen state.
- **State update**: call `register` right after every successful login/guest-session start (token ownership transfers to whoever registers it — see `08_NOTIFICATION_REFERENCE.md`), wire `PUT .../token` to `FirebaseMessaging.instance.onTokenRefresh`, and call `DELETE .../token` on logout for the current device.
- **Invalidation**: none needed — this data isn't read back and rendered anywhere in the app.

## Addresses (`addresses`)

- **Repository**: `AddressesRepository` wrapping full CRUD under `/me/addresses*`.
- **Provider**: `addressesProvider` (list).
- **State update**: every mutation (`POST`/`PUT`/`PATCH .../default`) returns the single updated `AddressResponseDto`, not the whole list — so for these, either (a) refetch the list (`ref.invalidate(addressesProvider)`), or (b) manually splice/replace the one changed address into local list state and re-sort/re-flag `isDefault` on the others client-side (more error-prone since `PATCH .../default` clears `isDefault` on every other address server-side — mirroring that logic client-side is easy to get wrong; **invalidation is the safer choice here**, unlike the cart's "always trust the response" rule above).
- **Caching**: safe to cache for the session; addresses change infrequently.
- **Invalidation**: after any address mutation, invalidate `addressesProvider`. Remember `deliveryAddress` at checkout is a **separate, inline copy** (`CheckoutDto.deliveryAddress`) — selecting a saved address in the checkout UI means copying its fields into the checkout request, not passing an id (see `02_API_REFERENCE.md` note).

## Favorites (`favorites`)

- **Repository**: `FavoritesRepository` wrapping `GET/POST /me/favorites`, `DELETE /me/favorites/:menuItemId`.
- **Provider**: `favoritesProvider` (list of full `MenuItemResponseDto`, not just ids).
- **State update**: both `GET` and the `POST` (add) response return the **full favorites array** — use the `POST` response to overwrite `favoritesProvider` directly, same "trust the mutation response" pattern as cart. `DELETE` returns `204` with no body — after a successful delete, either refetch or locally filter the removed `menuItemId` out of the cached list.
- **Caching**: session-scoped is fine; this is small, per-user data.

## Loyalty (`loyalty`)

- **Repository**: `LoyaltyRepository` wrapping `GET /me/loyalty`, `GET /me/loyalty/transactions`, `POST /me/loyalty/redeem` (legacy — see below).
- **Provider**: `loyaltyAccountProvider`, `loyaltyTransactionsProvider`.
- **Guard**: hide/disable the entire loyalty screen for guest sessions (`user.isGuest === true`) — every endpoint here (and checkout-time redemption) returns `403 GUEST_NOT_ELIGIBLE` for guests, so don't even surface the entry point.
- **Redeeming — two paths, prefer the checkout one**:
  - **At checkout (recommended)**: don't call `POST /me/loyalty/redeem` from the cart/checkout screen at all. Instead, let the user pick a reward in the checkout UI, store the chosen `rewardId` in local checkout-form state, and send it as `CheckoutDto.redeemRewardId` on the `POST /checkout` call itself. This is the atomic path — see `05_ORDER_LIFECYCLE.md`. On success, the checkout response's `loyaltyRedemption` field tells you what was redeemed; use it to update `loyaltyAccountProvider`'s cached balance locally (subtract `pointsRedeemed`) or just invalidate `loyaltyAccountProvider`/`loyaltyTransactionsProvider` after checkout, same pattern as any other post-checkout invalidation.
  - **Standalone (legacy)**: `POST /me/loyalty/redeem`, unrelated to any order, still works and is still the right call for a "redeem now, use later" UX if the product ever wants that — but be aware it has **no atomicity with anything the user does next**: points are spent the instant this call succeeds, full stop. If a redeem-then-checkout flow is ever built with this endpoint, understand that a checkout failure afterward does **not** refund the points — this is exactly the risk the new checkout-time path was built to eliminate, so **new checkout UI should use `redeemRewardId`, not this endpoint.**
- **Mutual exclusivity with promo codes**: the checkout screen should treat "apply promo code" and "redeem loyalty reward" as radio-button-exclusive UI state, not two independently-toggleable fields — sending both is a `422 PROMO_AND_LOYALTY_MUTUALLY_EXCLUSIVE`, avoidable entirely client-side by not letting the user select both at once.
- **State update (legacy endpoint)**: `redeem`'s response includes the updated account — use it to overwrite `loyaltyAccountProvider` directly, and invalidate `loyaltyTransactionsProvider` (the redemption response doesn't include the full transaction list, just the one new transaction's summary).
- **Reward catalog**: hardcode the same fixed list documented in `02_API_REFERENCE.md`/`03_DTO_REFERENCE.md` (`free-delivery`, `discount-10`, `discount-25`) client-side, or fetch it — **there is no `GET /me/loyalty/rewards` endpoint**, so if the UI needs to list redeemable rewards with names/costs, that list currently has to be duplicated client-side (flag this to backend if a rewards-catalog endpoint would help — see `10_FRONTEND_CHECKLIST.md`). Note `free-delivery` is only offerable when the checkout screen's currently-selected `deliveryMethod` is `DELIVERY` — grey it out (don't just let the call fail with `422 REWARD_NOT_APPLICABLE`) when `PICKUP` is selected.
- **Invalidation**: `loyaltyAccountProvider` should be invalidated after any successful checkout that included `redeemRewardId` (balance dropped), and whenever an order the user placed transitions to `delivered` (points are earned then) — the order-status push notification is a reasonable trigger for the latter, similar to the order-tracking pattern above.

## Admin Orders (`orders` admin routes)

- **Repository**: `AdminOrdersRepository` wrapping `GET /admin/orders*`, `PATCH /admin/orders/:id/status`.
- **Provider**: `adminOrdersListProvider(status?, q?, page)`, `adminOrderDetailProvider(id)`.
- **State update**: `PATCH .../status` returns the full updated `OrderResponseDto` — use it to update `adminOrderDetailProvider(id)` directly, and either optimistically patch the matching row in `adminOrdersListProvider`'s cached list or invalidate it (same "Admin Catalog" pattern — this is another spot the same stale-list bug class can appear if only a toast is shown on success).
- **UI guardrail**: only render status-transition buttons that are actually legal from the order's current status (see the exact table in `05_ORDER_LIFECYCLE.md`) — attempting an illegal transition returns `422 INVALID_STATUS_TRANSITION`, which is avoidable entirely client-side by mirroring that table.

## Admin Promos (`promos` admin routes)

- **Repository**: `AdminPromosRepository` wrapping `GET/POST /admin/promos`, `PUT/DELETE /admin/promos/:id`.
- **Provider**: `adminPromosListProvider`.
- **State update / Invalidation**: identical pattern to Admin Catalog — use the create/update response directly, or invalidate the list provider after every mutation.

## Admin Notifications (`notifications` admin routes)

- **Repository**: `AdminNotificationsRepository` wrapping `POST /admin/notifications/send|schedule`, `GET .../campaigns`, `DELETE .../campaigns/:id`.
- **Provider**: `adminCampaignsListProvider(page)`.
- **State update**: `send`/`schedule` return the created campaign — prepend it to `adminCampaignsListProvider`'s cached list (or invalidate). Note `send`'s response already reflects the **final** `SENT`/`FAILED` status (synchronous dispatch) — no polling needed for immediate sends. `schedule`'s response is `SCHEDULED` and will only change state (to `SENDING`→`SENT`/`FAILED`) up to ~60 seconds after `scheduledAt` — if the admin UI shows a live status, either poll `GET .../campaigns` around the scheduled time or accept it'll show `SCHEDULED` until the admin manually refreshes.
- **Deletion guard**: only show a delete action for campaigns whose `status` is `DRAFT` or `SCHEDULED` — mirror the `CAMPAIGN_NOT_DELETABLE` rule client-side to avoid a dead button.

---

## The one architectural takeaway

Every "created/updated but doesn't show up until manual refresh" bug in this system has the same shape and the
same fix: **a mutation endpoint's response already contains the fresh state — use it to update the relevant
list/detail provider directly, or explicitly invalidate that provider, in the same code path as the mutation
call.** Never rely on a toast/snackbar success message alone to "complete" a mutation's UI effect.
