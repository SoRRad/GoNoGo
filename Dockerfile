# syntax=docker/dockerfile:1

# --------------------------------------------------------------------------
# Build stage: needs a toolchain because better-sqlite3 is a native addon.
# --------------------------------------------------------------------------
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# No telemetry, no third-party calls, at build time or at run time.
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN npm run build && npm run build:scripts

# Drop devDependencies but keep the compiled native addon.
RUN npm prune --omit=dev


# --------------------------------------------------------------------------
# Runtime stage.
# --------------------------------------------------------------------------
FROM node:20-alpine AS runner

# libstdc++ is what the compiled better-sqlite3 binary links against.
RUN apk add --no-cache libstdc++ tini

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Database, frames and masks all live under one mount.
ENV DATA_DIR=/data

COPY --from=builder /app/node_modules   ./node_modules
COPY --from=builder /app/.next          ./.next
COPY --from=builder /app/dist           ./dist
COPY --from=builder /app/public         ./public
COPY --from=builder /app/scripts        ./scripts
COPY --from=builder /app/package.json   ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs

# uid/gid are pinned so a host-mounted disk can be chowned to match them.
# See the README: sudo chown -R 1001:1001 <mount point>
RUN addgroup -S -g 1001 sadi && adduser -S -u 1001 sadi -G sadi \
    && mkdir -p /data/frames /data/masks /data/exports \
    && chown -R sadi:sadi /data /app

USER sadi

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies so `docker compose exec` seeding leaves nothing behind.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "start"]
