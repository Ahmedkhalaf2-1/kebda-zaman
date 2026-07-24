#!/bin/sh
# Runs pending migrations against DATABASE_URL, then starts the API.
# `prisma migrate deploy` (never `migrate dev` in production, per plan §12) is
# safe to run from multiple concurrent container starts — Prisma serializes
# it with an advisory lock on the target database.
set -eu

npx prisma migrate deploy
exec node dist/main.js
