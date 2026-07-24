# Deployment Runbook — Kebda Zaman Backend

Status: running on a local Ubuntu VM via Docker Compose. This document is the
plan for moving to a real Ubuntu VPS (BACKEND_IMPLEMENTATION_PLAN.md §12).
**No VPS, domain, or TLS certificate exists yet** — nothing here has been
executed against real infrastructure.

## 1. Prerequisites not yet in place

These are hard requirements for a real production deployment and are
intentionally **not** provisioned by this phase:

- A VPS host (Ubuntu) with SSH access.
- A domain name with an `api.<domain>` A-record pointed at the VPS.
- A TLS certificate (Let's Encrypt via a reverse proxy — see §6).
- Real Firebase service-account credentials for the production Firebase
  project (FCM push notifications are a safe no-op without them — see §7).
- A chosen payment gateway (Moyasar/PayTabs/other) and its API
  keys/webhook secret — the app runs CASH-only until a `PaymentProvider`
  adapter is implemented and registered (see §8).

## 2. Environment configuration

Copy `.env.example` to `.env` on the target host and fill in **every**
value — do not reuse the example placeholders. As of Phase 10, boot fails
fast in production if `JWT_ACCESS_SECRET`, `DATABASE_URL`, or
`POSTGRES_PASSWORD` still contains the literal string `CHANGE_ME`
(`src/config/validation.schema.ts`), so a copy-pasted `.env.example` cannot
silently reach production.

Minimum required for a real deploy:

- `NODE_ENV=production`
- `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` — real, unique values.
- `DATABASE_URL` — matches the above (the `api` service in compose already
  overrides this to point at `db:5432` inside the Docker network; the value
  in `.env` only matters for host-side tooling).
- `JWT_ACCESS_SECRET` — a real random secret, e.g. `openssl rand -hex 32`.
- `CORS_ORIGINS` — the exact admin web origin(s); no wildcards.
- `FIREBASE_PROJECT_ID` / `FIREBASE_SERVICE_ACCOUNT_PATH` (or
  `_JSON`) — once real credentials exist (§7).

## 3. Deploying / updating

```sh
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

`docker-compose.prod.yml` adds resource limits and bounded/rotated JSON logs
on top of the base file — the base file alone is enough for local/dev use.

Migrations run automatically on container start
(`scripts/docker-entrypoint.sh` runs `prisma migrate deploy` before
`node dist/main.js`) — `migrate deploy` only applies already-committed,
reviewed migrations and is safe to run from a fresh container on every
deploy (Prisma serializes concurrent `migrate deploy` calls against the same
database with an advisory lock, so this is also safe if ever scaled to
multiple `api` replicas). Never run `prisma migrate dev` against a
production database.

To run a migration manually instead (e.g. before switching image versions):

```sh
docker compose run --rm api npx prisma migrate deploy
```

## 4. Verifying a deployment

```sh
docker compose ps                                   # both services healthy
curl -fsS http://localhost:3000/api/v1/health        # liveness
curl -fsS http://localhost:3000/api/v1/health/ready   # readiness (DB ping)
```

The compose `api` healthcheck itself now probes `/api/v1/health/ready`, so
`docker compose ps` only reports `healthy` once the API can really reach
Postgres, not merely once the process has started.

## 5. Database backup / restore

```sh
./scripts/db-backup.sh                 # writes ./backups/<db>_<timestamp>.dump
./scripts/db-restore.sh <backup-file>  # DESTRUCTIVE — prompts for confirmation
```

Both scripts shell out to `docker exec kz-db pg_dump`/`pg_restore` (custom
format) using the credentials in `.env`. On a real VPS, schedule
`db-backup.sh` via cron and copy `./backups/` off-host (rsync/object
storage) — this repo only provides the scripts, not the cron entry or
off-site sync target, which are host-specific.

**Rollback:** revert to the previous git commit/image tag, then restore the
matching backup with `db-restore.sh` if a migration in the bad release
changed the schema incompatibly. Forward-only migrations mean there is no
`prisma migrate down` — rollback is always "restore from backup," per plan
§12.

## 6. Reverse proxy / HTTPS (not yet configured)

Recommended: **Caddy** in front of `api` for automatic HTTPS via Let's
Encrypt (simplest option per plan §12). Terminates TLS, proxies to
`api:3000`, sets `X-Forwarded-*` headers, and must disable response
buffering for the `GET /orders/:id/stream` SSE route. Not added in this
phase — no domain exists yet to issue a certificate for.

Firewall (`ufw`) on the VPS should allow only 22 (restricted to a known IP if
possible), 80, and 443. **Postgres's 5432 must not be published on the VPS**
— the current `docker-compose.yml` publishes `db` on the host for local dev
convenience only; drop that `ports:` mapping (or override it to bind
`127.0.0.1` only) in the real VPS deployment.

## 7. Firebase credentials (not yet configured)

FCM sends are a safe no-op until `FIREBASE_SERVICE_ACCOUNT_PATH` (preferred:
mount the service-account JSON as a Docker secret / read-only file) or
`FIREBASE_SERVICE_ACCOUNT_JSON` is set — see `.env.example`. Nothing else
changes: `NotificationsService.isEnabled` reflects whichever state is
configured, and the admin notification-campaign endpoints already handle
both. Never commit the service-account file (already covered by
`.gitignore`).

## 8. Payment gateway credentials (not yet configured)

The payment architecture (`src/modules/payments/`) is gateway-agnostic by
design (Phase 8) — CASH works end-to-end today; CARD/WALLET return
`501 PAYMENT_PROVIDER_NOT_CONFIGURED` until a real `PaymentProvider` adapter
is implemented and registered in `payments.module.ts`. Adding a gateway
later needs only: the adapter class, its API key/webhook-secret env vars,
and registering it in the `PAYMENT_PROVIDERS` factory — no Order/Payment
schema or checkout-transaction changes.

## 9. Notification scheduler — multi-instance limitation

`CampaignsSchedulerService` polls Postgres every 60s via `@nestjs/schedule`
(`@Interval`) and claims due campaigns with a guarded
`updateMany({status: 'SCHEDULED'} -> {status: 'SENDING'})`. This makes
**double-send safe** across multiple `api` replicas — only one instance's
claim can succeed for a given campaign, the rest are no-ops. It is **not
efficient** at scale: every replica polls independently, so N replicas issue
N times the polling queries (negligible at this data volume, but worth
knowing). There is no leader election. If this backend is ever scaled to
several instances, this is acceptable as-is; if scheduling volume grows
significantly, consider moving the poll to a single dedicated instance/cron
job instead of every API replica.

## 10. Log rotation & retention

The base image logs structured JSON to stdout in production (`pino`,
`NODE_ENV=production`). `docker-compose.prod.yml` bounds this with Docker's
`json-file` driver (`max-size: 10m`, `max-file: 3`) so logs can't fill the
VPS disk. No log shipping to an external service is configured — add one
later if centralized log search/alerting is needed.
