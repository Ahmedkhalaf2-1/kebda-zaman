-- AlterEnum
-- PostgreSQL cannot use a new enum value in the same transaction that adds
-- it (see https://www.postgresql.org/docs/current/sql-altertype.html —
-- "safely be used in the same transaction it was added in" restriction still
-- applies at all supported PG versions, including this project's postgres:16
-- target). This migration ONLY adds the two new values; the historical data
-- backfill that reads/writes them lives in the next migration
-- (add_pickup_order_statuses_backfill), so it runs as its own transaction
-- after this one has already committed.
ALTER TYPE "OrderStatus" ADD VALUE 'READY_FOR_PICKUP';
ALTER TYPE "OrderStatus" ADD VALUE 'PICKED_UP';
