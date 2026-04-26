# syntax=docker/dockerfile:1.7
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_OUTPUT_STANDALONE=1
# Note: do NOT run `drizzle-kit generate` here. Migrations are source-controlled
# under lib/db/migrations/ and must be committed by hand. Auto-generating at
# build time creates spurious migrations whenever the snapshot file drifts
# from the schema (e.g. after a hand-written migration), which then fail at
# runtime against an already-migrated database.
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Use the node user (UID 1000) that ships with node:20-alpine.
# This matches the UID of files written by the host on a typical Linux server,
# so the volume-mounted /data directory is writable without a chown step.
RUN apk add --no-cache tini sqlite \
 && mkdir -p /data /app && chown -R node:node /data /app

COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/lib/db/migrations ./lib/db/migrations

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health > /dev/null || exit 1

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
