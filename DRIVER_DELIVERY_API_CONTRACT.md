# Delivery Driver API Contract — Phases 1 & 2

Phase 1 of the delivery-driver system: driver accounts (admin-managed, own
`DRIVER` role), manual admin assignment of a `DELIVERY` order to a driver, and
the driver-facing pickup/delivered actions. Phase 2 (below) adds live driver
location tracking on top of it — HTTP ingestion + polling only, no Google
Maps/Routes integration, no route/ETA calculation.

## Data model

- `UserRole.DRIVER` — a new role alongside `CUSTOMER`/`ADMIN`/`CASHIER`/
  `KITCHEN`. A driver is a normal `User` row (same auth/session infra), never
  a guest, never publicly self-registrable.
- `Order.driverId` — nullable FK to `User`, distinct from `Order.userId` (the
  customer). Only ever set on `DELIVERY` orders. Assignment never itself
  changes `status`. Not cleared when the driver is deactivated — the
  assignment (and its history) survives so an admin can see it and reassign.
- `OrderDriverAssignmentHistory` — audit trail: `orderId`, `fromDriverId`
  (null on first assignment), `toDriverId` (null on unassign),
  `changedByUserId` (the admin), `createdAt`. Mirrors `OrderStatusHistory`'s
  conventions. Migration `20260917205220_add_driver_role_and_assignment` is
  purely additive (new enum value, one nullable column, one new table with
  FKs/indexes) — no drops, no backfills, no data loss.

## Driver accounts (ADMIN-only, `/api/v1/admin/drivers`)

Reuses the exact identity/auth/password infrastructure every other role uses
(`PasswordService`, `TokenService`, the `deletedAt` soft-delete/deactivation
convention) — same pattern as `StaffController` (`CASHIER`/`KITCHEN`), kept as
its own module/role rather than folded into `StaffController` since drivers
have their own assignment/order-visibility model.

All routes `@Roles('ADMIN')` only — `CASHIER`/`KITCHEN`/`DRIVER`/`CUSTOMER`
get `403 FORBIDDEN`. There is no public registration path for `DRIVER`:
`POST /auth/register` has no `role` field at all (rejected outright by the
global `whitelist: true, forbidNonWhitelisted: true` validation pipe if sent),
and always creates a `CUSTOMER`.

### `POST /api/v1/admin/drivers`

```json
{ "name": "Ahmed Driver", "email": "driver1@example.com", "password": "at-least-8-chars", "phone": "0500000000" }
```

→ `201`, `DriverResponseDto`:

```json
{ "id": "uuid", "name": "string", "email": "string | null", "phone": "string | null", "isActive": true, "createdAt": "ISO 8601" }
```

`passwordHash` is never included in any response (same field-picking
convention as `UserResponseDto`/`StaffResponseDto`). Errors: `409
EMAIL_ALREADY_EXISTS`.

### `GET /api/v1/admin/drivers?q=&isActive=&page=&limit=`

Paginated (`page` default 1, `limit` default 20, max 100 — same convention as
`GET /admin/customers`). `q` free-text searches name/email/phone. Returns a
plain JSON array (no `total` envelope — same convention as
`/admin/orders`/`/admin/customers`).

### `GET /api/v1/admin/drivers/:id`

Single `DriverResponseDto`. `404 DRIVER_NOT_FOUND`.

### `PATCH /api/v1/admin/drivers/:id`

Body (`UpdateDriverDto`, all fields optional — only supplied fields change):

```json
{ "name": "string", "email": "string", "phone": "string", "password": "string", "isActive": true }
```

`isActive: false` sets `deletedAt` (same mechanism `StaffService`/
`CustomersService` use); `isActive: true` clears it. Deactivating additionally:

1. Revokes every refresh-token session for that driver immediately
   (`TokenService.revokeAllForUser` — same mechanism `logout-all` uses), and
2. Is enforced on the driver's **already-issued, not-yet-expired access
   token** on the very next driver-endpoint request — see `ActiveDriverGuard`
   below. This closes a gap that exists for every other role in this
   codebase today: `JwtAccessGuard` only verifies the JWT signature, it never
   re-reads the user row, so a deactivated `CASHIER`/`KITCHEN`/`ADMIN`'s
   still-valid access token keeps working until it naturally expires.
   `ActiveDriverGuard` re-checks the DB on every request, but **only** for a
   principal whose token claims `DRIVER` and only on the driver-facing
   controller — it is not registered globally, so this does not add a DB
   round-trip to every request for every other role.

Orders already assigned to a deactivated driver are **not** unassigned —
`Order.driverId` is left as-is so an admin can see the assignment and
reassign it.

## Driver login (Flutter)

No new endpoint — a driver logs in through the exact same
`POST /api/v1/auth/login` every other role uses. The response's
`user.role` is `"DRIVER"`; the Flutter app should route a `DRIVER` principal
to the driver UI the same way it presumably already switches on `ADMIN`/
`CASHIER`/`KITCHEN` today. Deactivated-driver login attempts get the same
`401 INVALID_CREDENTIALS` every other deactivated account gets (the `deletedAt:
null` filter in `AuthService.authenticate` already covers this — no new
logic needed).

## Order assignment (ADMIN-only, on `/api/v1/admin/orders`)

Added to the existing `AdminOrdersController` (`@Roles('ADMIN', 'CASHIER')` at
the class level); both new routes override to **`@Roles('ADMIN')` only** —
manual driver assignment is an administrator responsibility, `CASHIER` gets
`403`.

### `PATCH /api/v1/admin/orders/:id/driver`

Body: `{ "driverId": "uuid" }`. Assigns or reassigns. Reassigning to a
different driver **immediately** revokes the previous driver's access — their
every read/write filters `WHERE driverId = <them>`, so the moment `driverId`
changes they simply stop matching; no separate revoke step exists or is
needed. Response: the full `AdminOrderResponseDto` (now includes `driverId`).

Rules enforced, each atomically inside one DB transaction:

- Only `DELIVERY` orders → else `422 NOT_A_DELIVERY_ORDER`.
- Not `DELIVERED`/`CANCELLED` → else `422 ORDER_ALREADY_TERMINAL`.
- Target must be an active (`deletedAt: null`), non-deleted `DRIVER` → else
  `422 DRIVER_NOT_AVAILABLE`.
- Re-assigning the exact same driver is a no-op (idempotent success, no audit
  row written).
- Concurrency: the write is an optimistic `UPDATE ... WHERE driverId =
  <the value just read>`, which Postgres itself serializes against a second
  concurrent assignment call on the same order — the loser gets `409
  ASSIGNMENT_CHANGED` deterministically, never a lost update.
- Every successful change (not the no-op case) writes one
  `OrderDriverAssignmentHistory` row.

### `DELETE /api/v1/admin/orders/:id/driver`

Unassigns (`driverId: null`). Same rules/response shape as above.

## Driver-facing endpoints (`@Roles('DRIVER')`, `/api/v1/driver/orders`)

Guarded by both the global `RolesGuard` (`DRIVER` only) and
`ActiveDriverGuard` (deactivation check — see above). Every read and write
re-checks ownership (`driverId = <caller>`) server-side; a non-owned or
unknown order is always `404 ORDER_NOT_ASSIGNED` — indistinguishable from
"doesn't exist" (no existence leak).

Response shape (`DriverOrderResponseDto`) is intentionally minimal — never
prices beyond the total, never promo/loyalty detail, never payment-provider
internals, never the customer's email:

```json
{
  "id": "uuid",
  "orderNumber": "string",
  "status": "preparing | outForDelivery | ...",
  "items": [ "...same OrderItemResponseDto shape used elsewhere" ],
  "deliveryAddress": { "title": "string", "street": "string", "...": "...", "latitude": 21.5, "longitude": 39.1 },
  "deliveryMethod": "DELIVERY",
  "customerName": "string",
  "customerPhone": "string | null",
  "paymentMethod": "cash | card | wallet",
  "paymentStatus": "PENDING | PAID | CAPTURED | ...",
  "amountToCollect": 55.0,
  "totalAmount": 55.0,
  "createdAt": "ISO 8601"
}
```

`amountToCollect` is the order total for an unpaid `CASH` order, `0`
otherwise (already `PAID`/`CAPTURED`, or `CARD`/`WALLET`) — informational
only, never itself a signal that changes payment state.

### `GET /api/v1/driver/orders?page=&limit=`

Paginated active assigned orders (any non-terminal status — `PENDING`,
`CONFIRMED`, `PREPARING`, `OUT_FOR_DELIVERY`; assignment can happen before an
order even reaches `PREPARING`).

### `GET /api/v1/driver/orders/history?page=&limit=`

Paginated completed-delivery history: `DELIVERED` or `CANCELLED` orders
**still currently assigned** to this driver (a reassigned-away order
disappears from history too, matching "previous driver loses access").
`customerPhone` is always `null` here — the one field stripped once the
delivery is over, per the minimize-customer-info-in-history requirement.

### `GET /api/v1/driver/orders/:id`

Single order detail, ownership-checked. Unscoped by status (like the
existing `KitchenOrdersController.getOrder` convention) — a driver already
viewing an order doesn't 404 just because it reached a terminal status
mid-view.

### `PATCH /api/v1/driver/orders/:id/pickup` — "Picked up / Start delivery"

`PREPARING → OUT_FOR_DELIVERY`. Maps onto the **existing** delivery
transition map (`OrdersService`'s `DELIVERY_ALLOWED_TRANSITIONS`) — no new
status was invented. Rejects any other current status (e.g. still `PENDING`)
with `422 INVALID_STATUS_TRANSITION`, same code the admin status-update path
already uses.

### `PATCH /api/v1/driver/orders/:id/delivered` — "Delivered"

`OUT_FOR_DELIVERY → DELIVERED`. Internally delegates to the exact same
`OrdersService.updateOrderStatus` the admin path uses, so COD settlement
(`PaymentsService.settleCashOnDelivery` — a no-op for `CARD`/`WALLET` or an
already-settled `CASH` payment, never marks an unpaid order paid on its own),
loyalty earning, and the customer push notification all fire identically —
nothing was duplicated or reimplemented.

**Idempotency / concurrency**: both actions pre-check "already at the target
status" and return the current state with **no** new history row and **no**
re-fired side effects for a retried/duplicated request that arrives after the
first one committed. A genuinely simultaneous duplicate (two requests racing
at the same instant, before either commits) is still safe — no corruption,
no duplicate side effects — but resolves as one `200` + one `409
ORDER_STATUS_CHANGED`, since the idempotency pre-check and the atomic claim
are two separate reads; this only affects the rare true-simultaneous case; a
sequential retry (the realistic mobile-client scenario) always gets a clean
`200` replay. Reassignment mid-flight is also covered atomically: the DB
claim additionally requires `driverId` to still match at commit time, so a
driver who was reassigned away between their ownership check and the write
gets `409`/`404` rather than silently succeeding.

A driver can never change price, customer details, arbitrary statuses,
payment records, or payment status — only these two specific, pre-validated
transitions exist on this controller.

## Compatibility

- Every existing endpoint/DTO is unchanged. `AdminOrderResponseDto` gained
  one new additive field (`driverId: string | null`) — safe for existing
  clients to ignore.
- Customer checkout, guest browsing, and every other admin order action are
  untouched — driver assignment is purely additive on top of the existing
  order lifecycle.
- Migration is additive-only; see "Data model" above.

## Phase 2 — live driver location tracking

Backend-only: HTTP ingestion + polling (no WebSockets/Redis — this codebase
has no real-time transport to reuse, confirmed by inspection), no Google
Maps/Routes integration, no route/ETA calculation. Migration
`20260917215132_add_driver_location_tracking` is additive-only (one
`NOT NULL DEFAULT 0` column on `Order`, one new table) — no drops, no
backfills.

### Data model

- `Order.driverAssignmentVersion` (`Int`, default `0`) — bumped by exactly 1
  every time `OrdersService.assignDriver` actually changes `driverId`
  (assign, reassign, or unassign — never on the existing no-op branch, i.e.
  re-assigning the same driver a second time). This is the "assignment
  identity" a location upload is tagged with. A plain `driverId` equality
  check cannot distinguish "still the original assignment" from "reassigned
  back to the same driver" — the version can, and every read/write compares
  against it.
- `OrderDriverLocation` — **one row per order** (`orderId` is the primary
  key), upserted in place on every valid upload. This is deliberately a
  latest-only "current state" row, **never** an appended GPS breadcrumb
  history. Columns: `driverId`, `assignmentVersion` (a copy of the order's
  `driverAssignmentVersion` at accept-time), `latitude`/`longitude`
  (`Decimal(9,6)`), `accuracyMeters`/`headingDegrees`/`speedMps` (all
  optional), `capturedAt` (client-reported fix time), `receivedAt` (server
  receipt time, `@default(now())`).

### `PUT /api/v1/driver/orders/:id/location` — driver uploads a location

DRIVER-only, on the existing `DriverOrdersController`
(`ActiveDriverGuard`-protected like every route there — a deactivated
driver's still-valid token is rejected here too). Body
(`UpdateDriverLocationDto`):

```json
{
  "latitude": 21.5433,
  "longitude": 39.1728,
  "capturedAt": "2026-01-01T12:00:00.000Z",
  "accuracyMeters": 12.5,
  "headingDegrees": 90.0,
  "speedMps": 8.2,
  "assignmentVersion": 3
}
```

- `latitude`: number, -90..90. `longitude`: number, -180..180. Both reject
  NaN/Infinity (`class-validator`'s `IsNumber()` default).
- `capturedAt`: ISO 8601 string (`IsDateString`), required. The device's fix
  time, never the upload time.
- `accuracyMeters` (optional): 0-10000. Beyond ~10km the fix is unusable, not
  real GPS accuracy.
- `headingDegrees` (optional): 0-359.999 — compass bearing.
- `speedMps` (optional): 0-100 (~360 km/h) — a ceiling that only exists to
  reject corrupt data, not to model any real delivery speed.
- `assignmentVersion`: required integer — the value the driver's app last
  read for this order (see `DriverOrderResponseDto.assignmentVersion` below).

Response `200` (`LocationAckResponseDto`):

```json
{ "accepted": true, "assignmentVersion": 3, "receivedAt": "2026-01-01T12:00:01.200Z" }
```

`accepted: false` (still `200`, not an error) means the sample was validated
and belongs to the current assignment, but was **not newer** than what's
already stored (a duplicate or out-of-order/delayed retry) — the driver app
should treat this identically to `true` (nothing to retry).

**Ownership/lifecycle rules enforced, in order:**

1. `capturedAt` bounds: rejects a sample more than `MAX_LOCATION_AGE_SECONDS`
   (**300s / 5 minutes**) old, or more than
   `MAX_LOCATION_FUTURE_SKEW_SECONDS` (**60s / 1 minute**) in the future
   (server clock) — `422 LOCATION_TOO_OLD` / `422 LOCATION_TIMESTAMP_IN_FUTURE`.
2. Order must exist and be assigned to the caller → else
   `404 ORDER_NOT_ASSIGNED` (identical wording/code to the existing
   pickup/delivered ownership check — no existence leak).
3. Order must be `DELIVERY` → else `422 NOT_A_DELIVERY_ORDER`.
4. Order must currently be `OUT_FOR_DELIVERY` → else
   `422 ORDER_NOT_OUT_FOR_DELIVERY` (covers PENDING/CONFIRMED/PREPARING
   before dispatch and DELIVERED/CANCELLED afterward with the same code).
5. `dto.assignmentVersion` must equal the order's current
   `driverAssignmentVersion` → else `409 ASSIGNMENT_VERSION_MISMATCH`
   (`details.currentAssignmentVersion` included so the app can resync).

**Atomicity — order lifecycle (assignment/status/version)**: steps 2-5 are
re-verified a second time *inside* a DB transaction via the same
optimistic-claim idiom `OrdersService.runStatusTransition`/`assignDriver`
already use — a guarded `UPDATE ... WHERE driverId = X AND status =
'OUT_FOR_DELIVERY' AND driverAssignmentVersion = Y`. Postgres's row lock on
that `UPDATE` is what makes this atomic: a concurrent reassignment,
unassignment, or delivery completion that commits first makes this claim
fail (`409`) instead of racing the location write.

**Atomicity — the location write itself**: enforced by a single conditional
`INSERT ... ON CONFLICT ("orderId") DO UPDATE ... WHERE` statement (raw SQL,
via `$queryRaw` inside the same transaction as the claim above) — **not** by
a preceding read followed by a separate write. This distinction matters and
was fixed after review: Prisma's ORM-level `.upsert()` compiles (verified
against this project's Prisma 6 / Postgres 16) to `INSERT ... ON CONFLICT
(orderId) DO UPDATE SET ... WHERE (orderId = $1 AND 1=1)` — i.e. the update
branch is **unconditional** once a conflict is found. The original
implementation decided "is this sample newer?" by reading
`OrderDriverLocation` first and then calling `.upsert()` unconditionally —
safe only insofar as it happened to depend on the *separate* Order-row lock
above also serializing the two writes, which is true today but not something
a reader of the `OrderDriverLocation` code alone could verify, and not
something guaranteed to survive an unrelated future refactor of that lock
(e.g. dropping its `updatedAt` touch as apparent dead code). The fix moves
the "never move backward" decision into the write's own `WHERE` clause, so
it is correct by inspection of one SQL statement, independent of any other
table's locking:

```sql
INSERT INTO "OrderDriverLocation" (...) VALUES (...)
ON CONFLICT ("orderId") DO UPDATE SET ...
WHERE "OrderDriverLocation"."assignmentVersion" < EXCLUDED."assignmentVersion"
   OR ("OrderDriverLocation"."assignmentVersion" = EXCLUDED."assignmentVersion"
       AND "OrderDriverLocation"."capturedAt" < EXCLUDED."capturedAt")
```

Semantics, all enforced by this one statement regardless of arrival order at
the database:
- No existing row (first-ever sample for the order) → the plain `INSERT`
  branch always applies; Postgres's own conflict handling serializes two
  simultaneous first uploads for the same order, so exactly one becomes the
  row and the other's conflict re-evaluates against it.
- Existing row from a **strictly older (superseded) assignment** → always
  overwritten regardless of its `capturedAt` — comparing timestamps across
  two different assignments is meaningless, and a stale assignment must
  never win just because its clock reads later.
- Existing row from the **same assignment** → overwritten only if the
  incoming sample's `capturedAt` is strictly greater. An exactly-equal
  timestamp deterministically loses (first-arrived-at-the-database sample
  wins ties) — a duplicate/retried upload is safely ignored (`accepted:
  false`) rather than refreshing `receivedAt` or otherwise touching the row.

This was proven (not just asserted) with two real, concurrently-executing
Postgres statements per case — one deliberately delayed via a `pg_sleep()`
CTE so its write reaches the conflict-resolution step *after* the other has
already committed — confirming the **value**, not the arrival order, decides
the outcome in both directions. See
`test/driver-location-race.driver-location-race-spec.ts`.

**Rate limit**: dedicated per-route `@Throttle` — **60 requests / 60
seconds** per caller (`DRIVER_LOCATION_THROTTLE`), well above the global
default (100 req/60s shared across *all* of a driver's traffic) and above
`AUTH_THROTTLE`/`SENSITIVE_ROUTE_THROTTLE` (20/60s, sized for occasional
sensitive actions, not a moving GPS feed). Sizing: covers one order updating
as often as every 2s (generous headroom over the 5-10s target cadence) or up
to ~10 simultaneously `OUT_FOR_DELIVERY` orders each updating every 10s — a
generous batch-delivery upper bound — while still bounding abuse to a fixed
ceiling. Exceeding it returns the standard `429`.

`DriverOrderResponseDto` (active-orders list, history, detail — all
DRIVER-facing responses already documented above) gained one additive field:

```json
{ "...": "...", "assignmentVersion": 3 }
```

### `GET /api/v1/orders/:id/tracking` — customer tracking read

No `@Roles()` override — same convention as its siblings `getOrder`/
`getOrderStatus`: open to any authenticated owner (guests included),
ownership enforced by `userId` match inside the service, not by role. Sets
`Cache-Control: no-store`.

### `GET /api/v1/admin/orders/:id/tracking` — staff tracking read

No role override — inherits `AdminOrdersController`'s class-level
`ADMIN` + `CASHIER` (the same "authorized staff" bar as every other read on
that controller; `DRIVER` gets `403`). Also `no-store`.

Both endpoints return the same shape (`OrderTrackingResponseDto`):

```json
{
  "orderId": "uuid",
  "state": "ACTIVE",
  "driverName": "Ahmed Driver",
  "driverPhone": "0500000000",
  "location": {
    "latitude": 21.5433,
    "longitude": 39.1728,
    "accuracyMeters": 12.5,
    "headingDegrees": 90.0,
    "speedMps": 8.2,
    "capturedAt": "2026-01-01T12:00:00.000Z",
    "receivedAt": "2026-01-01T12:00:01.200Z"
  },
  "locationAgeSeconds": 4
}
```

**`state`** (5 values, derived fresh on every read — never cached client-side
state):

| `state` | Meaning | `driverName`/`driverPhone` | `location` |
|---|---|---|---|
| `NOT_STARTED` | Order hasn't reached `OUT_FOR_DELIVERY` yet (includes every `PICKUP` order, which never will) | `null` | `null` |
| `WAITING_FOR_LOCATION` | `OUT_FOR_DELIVERY`, an active driver is assigned, but no sample exists yet for the **current** assignment version | present | `null` |
| `ACTIVE` | A sample for the current assignment exists and is within the freshness threshold | present | present |
| `STALE` | Same as `ACTIVE` but older than the freshness threshold | present | present (**real** coordinates/timestamps — just never call this "current") |
| `ENDED` | Order reached a terminal status (`DELIVERED`/`PICKED_UP`/`CANCELLED`), was unassigned mid-delivery, or its driver was deactivated | `null` | `null` |

**Freshness threshold**: `TRACKING_FRESHNESS_THRESHOLD_SECONDS = 30` —
roughly 3-6x the 5-10s upload cadence, so ordinary jitter or one missed beat
doesn't flip the state, while a driver who has genuinely stopped reporting is
flagged within half a minute. `locationAgeSeconds` gives the same signal
quantitatively (`null` exactly when `location` is `null`).

**A stale/obsolete sample is never carried into the current delivery**:
`WAITING_FOR_LOCATION` (not `ACTIVE`/`STALE`) is returned whenever the stored
row's `assignmentVersion` doesn't match the order's live
`driverAssignmentVersion` — this is what makes "reassigned away and back to
the same driver" safe: the second assignment gets its own version, so the
first assignment's last-known row (even if the physical row hasn't been
cleaned up yet) can never resurface as if it were current. This check is
purely a live read-time comparison — logical access is blocked **instantly**,
regardless of when (or whether) the cleanup job below has run.

### Retention / cleanup

`DriverLocationCleanupService` (`@Interval`, same no-Redis polling pattern as
the existing `CampaignsSchedulerService`) runs every **15 minutes** and
deletes any `OrderDriverLocation` row whose order is no longer trackable
(`status != OUT_FOR_DELIVERY` or `driverId IS NULL`), with a 10-minute grace
period after the row's last update. This is **storage hygiene only, not a
security boundary** — the state-derivation logic above already makes a
location instantly inaccessible the moment tracking ends, independent of
when this job runs.

### Manual testing note

Nothing here calls Google/any paid service — `latitude`/`longitude` are
plain client-supplied numbers, validated and stored as-is (no geocoding, no
distance calculation reused from `DeliveryPricingService`/`GoogleRoutesService`).

## What Flutter (Phase 2 client work) still needs

Backend Phase 2 provides the endpoints above; still entirely open on the
client side:

- **Driver app**: request foreground **and background** location permission
  (iOS "Always"/Android background location — a stricter permission tier
  than most apps need), start a location stream once an order reaches
  `OUT_FOR_DELIVERY` (poll `GET /driver/orders` or react to the pickup
  response), `PUT` a sample every **5-10 seconds while moving** (a
  reasonable client policy: skip an upload if the position hasn't moved
  meaningfully and less than ~20s have passed, to save battery/data without
  going stale), always send the `assignmentVersion` from the most recently
  fetched order detail, and stop uploading the instant the order leaves
  `OUT_FOR_DELIVERY` (delivered/cancelled/reassigned-away — a `404`/`409`
  response is the server's explicit signal to stop, not just an error to
  retry).
- **Customer app**: poll `GET /orders/:id/tracking` roughly every **10
  seconds** *only while the tracking screen is actually visible* — stop
  polling (don't just slow down) when the screen is backgrounded/closed or
  `state` becomes `ENDED`; a `WAITING_FOR_LOCATION` state is a normal
  transient state to show a "connecting..." UI for, not an error.
- **Backend limitations Flutter must independently account for**: this
  phase cannot guarantee a phone keeps sending location when the device is
  locked, the app is backgrounded/killed, or connectivity drops — background
  execution reliability (Android Doze/battery optimization exemptions, iOS
  background modes), offline queuing/replay of missed samples, and
  permission-denied/degraded-accuracy UX are all unaddressed here and belong
  entirely to the Flutter implementation.
- No map rendering, route line, or ETA exists anywhere in this phase (no
  Google Maps/Routes integration was added) — the response gives only a raw
  lat/lon point plus optional heading/speed for the client to plot.
