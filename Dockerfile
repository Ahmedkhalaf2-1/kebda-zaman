# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Kebda Zaman Backend — production-ready multi-stage build
# Pinned to Node 22 LTS (Alpine). openssl is required by Prisma's engine.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS base
RUN apk add --no-cache openssl
WORKDIR /app

# --- deps: full dependency install + Prisma client generation ---------------
# python3/make/g++ are needed only here: argon2 ships no musl (Alpine) prebuild,
# so node-gyp-build compiles it from source. Not carried into `runtime`.
FROM base AS deps
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate

# --- build: compile TypeScript -> dist --------------------------------------
FROM deps AS build
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# --- prod-deps: production-only node_modules (+ generated Prisma client) -----
FROM base AS prod-deps
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev
COPY prisma ./prisma
RUN npx prisma generate

# --- runtime: minimal image, non-root ---------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
RUN apk add --no-cache curl \
  && addgroup -S app && adduser -S app -G app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=prod-deps /app/prisma ./prisma
COPY package*.json ./
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
RUN chmod +x ./scripts/docker-entrypoint.sh
# Uploaded-file storage (bind-mounted via the `uploads` volume in compose) — created
# and owned by the non-root runtime user up front so it's writable at first boot.
RUN mkdir -p ./uploads && chown -R app:app ./uploads
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/v1/health || exit 1
CMD ["./scripts/docker-entrypoint.sh"]
