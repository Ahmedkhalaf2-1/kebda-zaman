# 05 — Order Lifecycle

Source of truth: `src/modules/orders/orders.service.ts` (`ALLOWED_TRANSITIONS`), `src/modules/payments/payments.service.ts` (`ALLOWED_PAYMENT_TRANSITIONS`), `src/common/mappers/order-response.mapper.ts` (wire-format status casing).

## End-to-end flow

```
┌─────────────┐
│  Customer   │  browses public catalog — no auth required
│  (or guest) │  GET /categories, /menu, /menu/search, /home/featured
└──────┬──────┘
       │
       ▼
┌─────────────┐  one persistent Cart per user, created lazily
│    Cart     │  POST/PUT/DELETE /cart/items/*, POST /cart/apply-promo
│             │  every add/update is re-priced & re-validated server-side
└──────┬──────┘  (availability, variant/addon rules, promo eligibility)
       │
       ▼
┌─────────────┐  POST /checkout (= POST /orders, same handler)
│  Checkout   │  server re-prices the ENTIRE cart from scratch — nothing
│             │  the client sent earlier (prices, totals) is trusted
└──────┬──────┘  cart cleared only inside the same DB transaction as order creation
       │
       ▼
┌─────────────┐  Order row created: status = PENDING, paymentStatus = PENDING
│   Order     │  a Payment row is also created (status PENDING) in the same tx
│  created    │  OrderStatusHistory row #1: fromStatus=null, toStatus=PENDING
└──────┬──────┘
       │
       ▼
┌─────────────┐  PATCH /admin/orders/:id/status  (ADMIN only)
│    Admin    │  validated against the transition table below
│   updates   │  writes Order.status + a new OrderStatusHistory row, same tx
│   status    │  on failure/invalid transition: 422 INVALID_STATUS_TRANSITION
└──────┬──────┘
       │  after the status-change transaction COMMITS (best-effort, never
       │  rolls back the already-committed change if these fail):
       │    • if newStatus == DELIVERED: pending CASH payment → settled PAID
       │    • if newStatus == DELIVERED: loyalty points credited (non-guest only)
       │    • FCM push sent to the customer's active devices, every transition
       ▼
┌─────────────┐  GET /orders/:id/status  — poll or refresh-on-push
│  Customer   │  returns { status, statusHistory[], estimatedDeliveryTime }
│  tracking   │  GET /orders/:id — full order detail
└─────────────┘  GET /orders — customer's own order list
```

## Order status state machine

Six statuses total (DB enum `OrderStatus`). Wire format is lowerCamel; DB storage is UPPER_SNAKE — the mapper converts both directions transparently, the frontend only ever sees lowerCamel.

| DB value | Wire value |
|---|---|
| `PENDING` | `pending` |
| `CONFIRMED` | `confirmed` |
| `PREPARING` | `preparing` |
| `OUT_FOR_DELIVERY` | `outForDelivery` |
| `DELIVERED` | `delivered` |
| `CANCELLED` | `cancelled` |

### Allowed transitions (exact, from `ALLOWED_TRANSITIONS`)

```
PENDING ──────────► CONFIRMED ──────────► PREPARING ──────────► OUT_FOR_DELIVERY ──────────► DELIVERED
   │                    │                     │                        │
   └──────────────────► CANCELLED ◄───────────┴────────────────────────┘
```

| From | Allowed `to` values |
|---|---|
| `PENDING` | `CONFIRMED`, `CANCELLED` |
| `CONFIRMED` | `PREPARING`, `CANCELLED` |
| `PREPARING` | `OUT_FOR_DELIVERY`, `CANCELLED` |
| `OUT_FOR_DELIVERY` | `DELIVERED`, `CANCELLED` |
| `DELIVERED` | *(none — terminal)* |
| `CANCELLED` | *(none — terminal)* |

Rules that follow directly from this table, all enforced server-side (`422 INVALID_STATUS_TRANSITION` on violation) — **the frontend must mirror these when deciding which status-change buttons to show an admin**:
- Every forward step must go through every intermediate status — you **cannot** skip from `PENDING` straight to `PREPARING` or `DELIVERED`.
- `CANCELLED` is reachable from any non-terminal status (`PENDING`/`CONFIRMED`/`PREPARING`/`OUT_FOR_DELIVERY`), but never from `DELIVERED`.
- Once `DELIVERED` or `CANCELLED`, the order is **permanently locked** — no further status changes are possible, including "un-cancelling."
- There is **no `READY` status** between `PREPARING` and `OUT_FOR_DELIVERY` — do not build UI around one.
- Same-status "transitions" (e.g. `PENDING` → `PENDING`) are **not** in any allowed-list and will be rejected.

### Side effects fired on a successful transition

All of the following run **after** the status-change DB transaction has already committed. Each is wrapped in its own try/catch and logged on failure — **a failure here never fails the `PATCH` request or rolls back the status change**, so the frontend should treat the `PATCH /admin/orders/:id/status` response as authoritative for the status itself even if a side effect silently failed.

1. **On transition to `DELIVERED` only:**
   - If the order's `paymentMethod` is `CASH` and its `Payment.status` is still `PENDING`, it is auto-settled to `PAID` (`Order.paymentStatus` updated to match). CARD/WALLET payments are untouched (no gateway to settle against).
   - Loyalty points are credited to the customer: `floor(totalAmount / 10)` points, **skipped entirely for guest accounts** (`isGuest: true`). Idempotent — a duplicate call for the same order is a silent no-op (unique constraint on `(orderId, reason)`).
2. **On every transition (including to `CANCELLED`):** a best-effort FCM push notification is sent to every active device token belonging to the order's owner. See `08_NOTIFICATION_REFERENCE.md` for the exact payload per status. If the customer has no registered/active device tokens, this is a silent no-op — not an error.

### What is *not* tracked despite schema columns existing

- `Order.cancelledAt` and `Order.cancelReason` — both columns exist in the schema but **no current service code ever writes them**. Cancelling an order only updates `status` to `CANCELLED` and appends an `OrderStatusHistory` row (whose optional `note` field is the closest thing to a reason, if the admin provided one in the `PATCH` body).
- `Order.estimatedDeliveryTime` — column exists, always `null` in every response today; nothing computes or sets it.

## Payment status state machine (subordinate to order status, not identical)

`Payment.status` (and the denormalized `Order.paymentStatus` mirror) is a **separate** state machine from order status:

| From | Allowed `to` values |
|---|---|
| `PENDING` | `PAID`, `FAILED` |
| `PAID` | `REFUNDED` |
| `FAILED` | *(none — terminal)* |
| `REFUNDED` | *(none — terminal)* |

- This table only matters for `POST /payments/webhook` processing (gateway-driven — currently no real gateway is wired up, see `02_API_REFERENCE.md`) and the automatic COD settlement on `DELIVERED` described above.
- A `CASH` order's payment sits at `PENDING` for the order's entire `PENDING → CONFIRMED → PREPARING → OUT_FOR_DELIVERY` journey and only flips to `PAID` the instant the order hits `DELIVERED`. **Do not build a "payment received" UI state for cash orders before delivery — it will never happen.**
- `CARD`/`WALLET` payments have no working path to `PAID` at all today (no gateway); their `Payment` rows will sit at `PENDING` indefinitely unless a real gateway is integrated later.

## Promo codes vs. loyalty redemption — mutually exclusive, and loyalty is atomic

`CheckoutDto` accepts `promoCode` and `redeemRewardId`, but **never both on the same checkout** — sending both
is rejected up front with `422 PROMO_AND_LOYALTY_MUTUALLY_EXCLUSIVE`, before the cart is even loaded. A customer
picks one discount mechanism per order: a promo code, or spending loyalty points, not a combination of the two.

Redeeming a loyalty reward at checkout (as opposed to the legacy standalone `POST /me/loyalty/redeem`) is
**atomic with order creation**:

1. The reward is evaluated (does the account have enough points? is the reward applicable — e.g. `free-delivery`
   is rejected on a `PICKUP` order since there's no fee to waive?) against the freshly-priced cart, before any
   database write happens.
2. Its effect (a flat subtotal discount, or a delivery-fee waiver) is folded into the same `discount` /
   `deliveryFee` / `tax` / `totalAmount` computation a promo code would use — one authoritative pricing path,
   not two.
3. The **actual point deduction and ledger insert happen inside the exact same database transaction** as
   `Order` creation, `OrderItem`/customization creation, and cart clearing.
4. If *anything* in that transaction fails — the account's balance changed in a race with another device, an
   order-number collision on retry, any other error — **the entire transaction rolls back**: the points are not
   spent, the order does not exist, and the cart is not cleared. There is no window where a customer can lose
   points without getting an order, or vice versa.

This is a hard guarantee enforced by the database transaction itself, not an application-level "try to undo it"
compensation step. The legacy `POST /me/loyalty/redeem` endpoint offers **no such guarantee** — it redeems
immediately and independently of any order, which is exactly the risk this atomic checkout path was built to
eliminate (see `09_FRONTEND_INTEGRATION.md` for the recommended migration path for frontend callers).

## Idempotency at checkout

`POST /checkout` accepts an optional `Idempotency-Key` header. If a caller retries the same checkout request with the same key (e.g. after a network timeout where the client is unsure whether the first attempt succeeded), the server detects the already-created `Payment` row (keyed by `user:<userId>:<header-value>`) and **returns the already-existing order again** instead of creating a duplicate. This applies to loyalty redemption too: a retried call never redeems a second time — it looks up the original redemption and returns the same `loyaltyRedemption` block both times. Frontend implication: **always send a stable idempotency key per checkout attempt** (e.g. a UUID generated once when the user taps "Place Order," reused across retries of that same tap — not regenerated per retry).

## Order number format

`KZ-YYMMDD-<8 random hex chars>`, e.g. `KZ-260724-a1b2c3d4`. Generated at checkout with up to 5 retry attempts on a (extremely unlikely) collision; a 6th collision would surface as a `500 ORDER_NUMBER_GENERATION_FAILED`.
