#!/bin/sh
# Dumps the compose Postgres database to ./backups/ in pg_dump custom format
# (restorable with db-restore.sh / pg_restore). Reads DB credentials from
# .env — same source of truth as the running stack, no separate config.
#
# Usage: ./scripts/db-backup.sh [output-dir]   (default: ./backups)
set -eu

cd "$(dirname "$0")/.."
[ -f .env ] && . ./.env

: "${POSTGRES_USER:?POSTGRES_USER not set (check .env)}"
: "${POSTGRES_DB:?POSTGRES_DB not set (check .env)}"

OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$OUT_DIR/${POSTGRES_DB}_${STAMP}.dump"

docker exec kz-db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom \
  >"$OUT_FILE"

echo "Backup written to $OUT_FILE"
