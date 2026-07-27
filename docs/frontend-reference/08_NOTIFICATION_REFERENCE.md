# 08 — Notification Reference

Source: `src/modules/notifications/*`, `src/modules/devices/*`.

## Architecture

```
Flutter app ──register/refresh FCM token──► POST/PUT /devices/*  ──► DeviceToken table
                                                                          │
Admin panel ──send/schedule campaign──► POST /admin/notifications/*     │
                                              │                          │
                                              ▼                          │
                                       NotificationCampaign table        │
                                              │                          │
                                              ▼                          │
                          CampaignsService.dispatch() ──resolves tokens──┘
                                              │
                                              ▼
                               Firebase Admin SDK → FCM → devices
                                              │
                                              ▼
                     Flutter app receives a DATA-ONLY message, parses it,
                     and is responsible for local notification display + deep-link navigation
```

Order-status changes go through the **same** `NotificationsService.sendToTokens` path, but bypass the
`NotificationCampaign` table entirely — they are not campaigns, just direct one-off sends triggered from
`OrdersService.updateOrderStatus`.

## Firebase configuration (server-side, informational)

- Uses the **Firebase Admin SDK** (not client SDK) server-side, initialized from either
  `FIREBASE_SERVICE_ACCOUNT_PATH` (a mounted JSON file) or `FIREBASE_SERVICE_ACCOUNT_JSON` (inline JSON string)
  — exactly one is expected to be set in a real deployment.
- **If neither is configured** (e.g. local dev, CI), Firebase initialization is skipped entirely and the app
  still boots normally — `NotificationsService.isEnabled` is `false`, and every send call becomes a logged
  no-op (`{ successCount: 0, failureCount: tokens.length, invalidTokens: [] }`). **This means: in some
  environments, push notifications simply will not arrive, with no error surfaced to any API caller** — don't
  interpret "no notification received" as a bug without first checking whether the environment has Firebase
  credentials configured.
- Firebase project id: `FIREBASE_PROJECT_ID` env var (documented default `keebda-zaman` — note the double-e,
  per the project's own audit notes).

## Device registration (Flutter → backend)

All under `/api/v1/devices`, any authenticated principal (guests included). See `03_DTO_REFERENCE.md` for exact DTOs.

| When | Call |
|---|---|
| App start / after login, with the current FCM token | `POST /devices/register { token, platform }` |
| `FirebaseMessaging.onTokenRefresh` fires | `PUT /devices/token { oldToken, token, platform }` (or omit `oldToken` — same as register) |
| Logout (current device only) | `DELETE /devices/token { token }` |

- `platform` is one of `ANDROID \| IOS \| WEB \| MACOS \| WINDOWS` — pick based on `Platform.isAndroid` / etc. in Flutter.
- Registration is an **upsert keyed by the raw FCM token string** — re-registering the same token just refreshes `lastSeenAt`/`isActive`/`userId`.
- **A device token always transfers to whichever user last registered it.** If User B logs in on a device that previously belonged to User A, User A silently stops receiving pushes on that device (their `DeviceToken.userId` is overwritten to User B). This is expected — call `register` on every login, not just app-first-install.
- A token FCM permanently reports as invalid (`messaging/registration-token-not-registered` or `messaging/invalid-argument`) is flipped `isActive: false` server-side automatically — it is **not** deleted, and re-registering the same token value re-activates it.

## The payload shape (what the Flutter app receives)

**Every push is a data-only FCM message** (no `notification:` block is set — only `data:`), matching this exact
key set (`AppNotificationPayload` → `toFcmDataPayload`, all values are strings since FCM data payloads must be
string-to-string):

```json
{
  "id": "uuid",
  "type": "order_confirmed",
  "title": "Order confirmed",
  "body": "Your order has been confirmed.",
  "route": "/orders/tracking/<orderId>",
  "entityId": "<orderId>",
  "imageUrl": "http://.../uploads/xxx.png",
  "timestamp": "1784910670401"
}
```
`route`, `entityId`, `imageUrl`, `timestamp` are **omitted from the payload entirely** (not sent as empty
strings) when not applicable — check for key presence, not falsy values, when parsing.

Since this is data-only, **the Flutter app is responsible for showing a local notification itself** (foreground
and, depending on platform, background too) — the backend never relies on FCM's own notification-tray display.

### `type` — the 14 allowed values (`NOTIFICATION_TYPES` in `notification-payload.ts`)
```
general, promotion, offer, new_product, category,
order_created, order_confirmed, order_preparing, order_ready,
order_out_for_delivery, order_delivered, order_cancelled,
payment_success, payment_failed
```
This exact list is validated at the DTO layer for admin campaigns (`CampaignDto.type` uses `@IsIn`). It was
deliberately matched field-for-field to an existing Flutter `NotificationType` enum/parser — if the Flutter
app's enum ever diverges from this list, campaigns using a type outside it will fail DTO validation with `400`
before ever reaching Firebase.

Note `order_ready` is in this list but **there is no corresponding `OrderStatus` value** (no `READY` status
exists — see `05_ORDER_LIFECYCLE.md`) and **no current code path ever sends it automatically**. It exists for a
possible future admin-triggered sub-state, not for order-status-driven notifications today.

## Order-status notifications (automatic, not admin-triggered)

Fired from `OrdersService.updateOrderStatus` after every successful status transition, to every active device
token owned by the order's customer. Mapping (`ORDER_STATUS_NOTIFICATION` in `notification-payload.ts`):

| Order status | `type` | title | body |
|---|---|---|---|
| `PENDING` | `order_created` | Order placed | Your order has been received. |
| `CONFIRMED` | `order_confirmed` | Order confirmed | Your order has been confirmed. |
| `PREPARING` | `order_preparing` | Order in progress | Your order is being prepared. |
| `OUT_FOR_DELIVERY` | `order_out_for_delivery` | Order out for delivery | Your order is on its way. |
| `DELIVERED` | `order_delivered` | Order delivered | Your order has been delivered. Enjoy! |
| `CANCELLED` | `order_cancelled` | Order cancelled | Your order has been cancelled. |

Every one of these sets `route: "/orders/tracking/<orderId>"` and `entityId: <orderId>` — this is the deep link
contract the Flutter app should navigate to when the notification is tapped. Titles/bodies above are **fixed,
English-only, hardcoded strings** — there is no i18n/localization for these (do not expect an Arabic variant
based on the user's `locale`).

## Admin-triggered campaigns (customer/guest broadcast notifications)

All under `/api/v1/admin/notifications`, ADMIN only. See `02_API_REFERENCE.md`/`03_DTO_REFERENCE.md` for full request/response shapes.

- **Immediate send** — `POST /admin/notifications/send`: persists the campaign, dispatches synchronously within the same request, and the response already reflects the final `SENT`/`FAILED` status.
- **Scheduled send** — `POST /admin/notifications/schedule` (adds a required `scheduledAt`): persists as `SCHEDULED`; an in-process poller (`CampaignsSchedulerService`, `@Interval` every 60 seconds) checks Postgres for due campaigns and dispatches them. No Redis/queue — durable across restarts because state lives in the DB, but **granularity is ~60 seconds** (a campaign scheduled for `10:00:05` may not actually send until `10:01:00`). Double-send across scheduler ticks/instances is prevented by an atomic `updateMany` claim on `status: SCHEDULED → SENDING`.
- **Target audience** — `targetAudience: "ALL" | "CUSTOMERS" | "GUESTS"` (default `ALL`), resolved against `DeviceToken` + the owning `User.isGuest`:
  - `CUSTOMERS` = tokens whose owning user has `isGuest: false`.
  - `GUESTS` = tokens with no owning user (`userId: null`) OR whose owning user has `isGuest: true`.
  - `ALL` = every active token, no filter.
- **Deep links** — `destinationRoute` (optional, ≤500 chars) and `entityId` (optional, ≤100 chars) on the campaign map directly to `route`/`entityId` in the FCM payload sent to devices — same contract as order-status notifications, just admin-authored instead of system-generated. The frontend's deep-link router should handle both sources identically.
- **Deletion** — `DELETE /admin/notifications/campaigns/:id` only works while `status` is `DRAFT` or `SCHEDULED`; once `SENDING`/`SENT`/`FAILED`, a campaign is permanent history (`409 CAMPAIGN_NOT_DELETABLE`).
- **Metrics** — `totalRecipients` and `deliveredCount` are populated from the actual FCM send result. `openedCount` and `clickRate` exist on the response shape but are **never computed by any code path** — they will always read `0`. Do not build an admin analytics screen expecting real open/click data; there is no tracking endpoint to populate them.

## Summary: what "broadcast" actually means here

There is no separate "broadcast" endpoint — a broadcast is simply a campaign with `targetAudience: "ALL"`. The
mechanism (immediate or scheduled) and delivery pipeline are identical to a targeted campaign; only the token
resolution query differs.
