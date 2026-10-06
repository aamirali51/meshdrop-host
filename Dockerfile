# syntax=docker/dockerfile:1
#
# MeshDrop host — headless node for NAS / servers.
# Build with the repo prepared (scripts/prepare-publish.js makes the engine dep a
# published semver and vendors the shared files), which is what CI does.

# Build stage: compile native deps (hyperswarm/udx-native/sodium-native) so the
# image works on every architecture, not only where prebuilds happen to exist.
FROM node:20-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:20-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /data /downloads

ENV MESHDROP_HOST_STORAGE=/data \
    MESHDROP_HOST_DOWNLOADS=/downloads \
    MESHDROP_HOST_PORT=41990 \
    PUID=1000 \
    PGID=1000

EXPOSE 41990

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.MESHDROP_HOST_PORT||41990)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "/app/index.js", "--storage", "/data"]
