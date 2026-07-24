#!/bin/sh
# Restores a pg_dump custom-format backup (as produced by db-backup.sh) into
# the compose Postgres database. DESTRUCTIVE: drops and recreates the target
# database's objects via pg_restore --clean --if-exists. Intended for
# disaster recovery / standing up a new environment from a known backup —
# confirm the target before running against anything with live data.
#
# Usage: ./scripts/db-restore.sh <backup-file>
set -eu

cd "$(dirname "$0")/.."
[ -f .env ] && . ./.env

: "${POSTGRES_USER:?POSTGRES_USER not set (check .env)}"
: "${POSTGRES_DB:?POSTGRES_DB not set (check .env)}"

BACKUP_FILE="${1:?Usage: db-restore.sh <backup-file>}"
[ -f "$BACKUP_FILE" ] || { echo "Backup file not found: $BACKUP_FILE" >&2; exit 1; }

echo "Restoring $BACKUP_FILE into ${POSTGRES_DB} (kz-db) — this will drop existing objects."
printf 'Continue? [y/N] '
read -r CONFIRM
[ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ] || { echo "Aborted."; exit 1; }

docker exec -i kz-db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --clean --if-exists --no-owner \
  <"$BACKUP_FILE"

echo "Restore complete."
