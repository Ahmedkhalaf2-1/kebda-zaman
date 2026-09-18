# Ratings & Reviews API Contract

Lets an authenticated, non-guest customer rate the food items they actually
purchased (per `OrderItem`, not per `MenuItem`) and optionally leave one
overall order-experience rating. Admins get read-only moderation APIs and
aggregate statistics. Public catalog responses (`GET /menu`,
`/menu/search`, `/home/featured`, `/menu/items/:id`) additionally expose
`averageRating`/`reviewCount` — see **Catalog integration** below. Written
comments are never exposed publicly — only admins can read them (V1 product
decision, avoids a moderation/privacy surface).

## Data model

- `ItemReview` — one row per purchased `OrderItem`. `orderItemId` is
  **unique**: this is both the "one review per purchased line" rule and the
  authoritative race guard (a racing duplicate create is caught and turned
  into `409 REVIEW_ALREADY_EXISTS`). `menuItemId` is a **soft reference**
  (plain UUID, no FK — same convention as `OrderItem.menuItemId`),
  snapshotted from the reviewed `OrderItem` at creation time, so a later
  `MenuItem` soft-delete never invalidates an existing review.
- `OrderFeedback` — at most one row per `Order` (`orderId` unique, same race
  guard pattern) for the optional overall rating/comment.
- Both models are purely additive — see migration `20260911005911_add_reviews`.

## Eligibility

An order is reviewable once `status` is `DELIVERED` or `PICKED_UP`. Every
other status — including `CANCELLED` — is rejected with
`422 ORDER_NOT_ELIGIBLE_FOR_REVIEW`.

## Customer endpoints

All require an authenticated `CUSTOMER` principal that is **not** a guest
(`role=CUSTOMER` alone doesn't exclude guests — checked explicitly in each
handler, same convention as `/me/loyalty`). A guest gets
`403 GUEST_CANNOT_REVIEW`.

### `POST /api/v1/reviews/items`

Body (`CreateItemReviewDto`):

```json
{ "orderItemId": "uuid", "rating": 5, "comment": "Very good" }
```

`userId`/`orderId`/`menuItemId` are always derived server-side from the
`OrderItem` — never trusted from the client. `rating` is a required integer
1-5. `comment` is optional, max 1000 chars, trimmed, and collapsed to `null`
if empty after trimming.

Response: `ItemReviewResponseDto`:

```json
{
  "id": "uuid",
  "orderItemId": "uuid",
  "menuItemId": "uuid | null",
  "rating": 5,
  "comment": "string | null",
  "createdAt": "ISO 8601",
  "updatedAt": "ISO 8601"
}
```

Errors: `404 ORDER_ITEM_NOT_FOUND` (missing, or belongs to another
customer — indistinguishable, IDOR-safe), `422 ORDER_NOT_ELIGIBLE_FOR_REVIEW`,
`409 REVIEW_ALREADY_EXISTS`, `400 INVALID_RATING`.

### `PATCH /api/v1/reviews/items/:reviewId`

Body (`UpdateItemReviewDto`): `{ "rating"?: number, "comment"?: string | null }` —
`orderId`/`orderItemId`/`menuItemId`/`userId` are not accepted fields at all,
so they can never be changed. Only the review's owner may edit
(`404 REVIEW_NOT_FOUND` for anyone else — same IDOR-safe convention).

**Tri-state PATCH semantics** (same convention as `CatalogService.
updateMenuItem`): each field is independently optional, and an **omitted**
field is left out of the underlying Prisma update entirely — its existing
value is preserved. This is distinct from an explicit `null`:

| `rating` in body | Effect | | `comment` in body | Effect |
|---|---|---|---|---|
| omitted | unchanged | | omitted | unchanged |
| `3` | updated to `3` | | `null` | cleared to `null` |
| | | | `""` or `"   "` | normalized and cleared to `null` |
| | | | `"text"` | trimmed and saved |

A bare `PATCH { "rating": 4 }` therefore updates only the rating and leaves
any existing comment untouched — it does **not** delete it.

### `GET /api/v1/reviews/me/orders/:orderId`

Returns every purchased line on the order (reviewed or not) built from the
order's own immutable snapshot fields (`nameArSnapshot`/`nameEnSnapshot`/
`imageUrlSnapshot`) — never a live `MenuItem` join, so it reads correctly
even after the item is renamed or soft-deleted.

```json
{
  "orderId": "uuid",
  "orderStatus": "delivered",
  "eligible": true,
  "items": [
    {
      "orderItemId": "uuid",
      "menuItemId": "uuid | null",
      "nameAr": "string",
      "nameEn": "string",
      "imageUrl": "string | null",
      "quantity": 2,
      "review": { "...ItemReviewResponseDto" } 
    }
  ],
  "orderFeedback": { "...OrderFeedbackResponseDto" } 
}
```

`review`/`orderFeedback` are `null` when not yet submitted. Errors:
`404 ORDER_NOT_FOUND` if the order doesn't belong to the caller.

### `POST /api/v1/reviews/orders`

Body (`CreateOrderFeedbackDto`): `{ "orderId": "uuid", "rating": 4, "comment": "..." }`.
Same eligibility/ownership rules as item reviews. One `OrderFeedback` per
order — a second attempt gets `409 ORDER_FEEDBACK_ALREADY_EXISTS`.

### `PATCH /api/v1/reviews/orders/:feedbackId`

Body (`UpdateOrderFeedbackDto`): `{ "rating"?: number, "comment"?: string | null }`.
Owner-only, `404 ORDER_FEEDBACK_NOT_FOUND` otherwise. Same tri-state PATCH
semantics as item reviews above — an omitted field is unchanged, `comment:
null`/`""`/whitespace-only clears the comment, a non-empty `comment` is
trimmed and saved.

## Admin endpoints

All `@Roles('ADMIN')` only — `CASHIER`/`KITCHEN`/`CUSTOMER` get
`403 FORBIDDEN`, same `RolesGuard` mechanism as `/admin/promos`,
`/admin/menu-offers`, `/admin/customers`, `/admin/reports` (review moderation
is not order-ops, unlike `/admin/orders` which also allows `CASHIER`).

### `GET /api/v1/admin/reviews/items`

Query (`AdminListItemReviewsDto`): `rating`, `menuItemId`, `orderId`,
`userId`, `from`/`to` (ISO date/datetime, inclusive — same semantics as the
existing `/admin/reports/*` date range), `page` (default 1), `limit`
(default 20, max 100).

**Pagination response shape**: a plain JSON array, same convention as
`GET /admin/orders` / `GET /admin/customers` — no envelope, no `total`.

```json
{
  "id": "uuid",
  "rating": 2,
  "comment": "string | null",
  "createdAt": "ISO 8601",
  "updatedAt": "ISO 8601",
  "customer": { "id": "uuid", "fullName": "string", "email": "string | null", "phone": "string | null" },
  "order": { "id": "uuid", "orderNumber": "string" },
  "item": { "orderItemId": "uuid", "menuItemId": "uuid | null", "nameAr": "string", "nameEn": "string", "imageUrl": "string | null" }
}
```

### `GET /api/v1/admin/reviews/orders`

Same shape/pagination convention, filters: `rating`, `orderId`, `userId`,
`from`/`to`, `page`, `limit` (no `menuItemId` — order feedback isn't tied to
one item).

### `GET /api/v1/admin/reviews/summary`

```json
{
  "itemReviews": { "averageRating": 4.4, "reviewCount": 420 },
  "orderFeedback": { "averageRating": 4.2, "reviewCount": 290 },
  "ratingDistribution": { "1": 2, "2": 3, "3": 10, "4": 20, "5": 92 },
  "topRatedItems": [
    { "menuItemId": "uuid", "nameAr": "string", "nameEn": "string", "imageUrl": "string | null", "averageRating": 4.9, "reviewCount": 40 }
  ],
  "lowestRatedItems": [ "...same shape" ]
}
```

`ratingDistribution` is the 1-5 breakdown across **all** `ItemReview` rows
(not order feedback). `topRatedItems`/`lowestRatedItems` only consider menu
items with **at least 5 reviews** (`MIN_REVIEWS_FOR_RANKING` in
`reviews.service.ts`) so a single 5-star (or 1-star) review can't dominate
the ranking; sorted deterministically by average rating, then review count,
then `menuItemId`, each strictly as a tie-breaker (never incidental row
order). Top 5 of each list.

## Catalog integration

`MenuItemResponseDto` (used by `GET /menu`, `/menu/search`, `/home/featured`,
and `GET /menu/items/:id`) now includes:

```json
{ "averageRating": 4.8, "reviewCount": 327 }
```

Individual written reviews/comments are never included on these public
responses — aggregates only. List/search/featured batch-fetch every item's
aggregate in **one** `groupBy` query per request (`ReviewsService.
getMenuItemRatingAggregates`) — never a per-item `COUNT`/`AVG` query. The
admin menu-management endpoints (`AdminMenuItemResponseDto`) are unchanged —
rating fields were intentionally not added there.

## Race safety

`ItemReview.orderItemId` and `OrderFeedback.orderId` are DB-level unique
constraints — the authoritative guard. `ReviewsService` pre-checks for a
friendly error, but also catches the Prisma `P2002` a racing concurrent
request can still produce and converts it into the same `409` response, so
a lost race never surfaces as a raw 500.
