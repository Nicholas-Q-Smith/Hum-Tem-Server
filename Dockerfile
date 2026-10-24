# syntax=docker/dockerfile:1
# Multi-arch: builds natively on the Pi (linux/arm64) or anywhere else.

FROM node:22-trixie-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 libbluetooth-dev libudev-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-trixie-slim
# libudev1: runtime lib for noble's native USB/HCI modules.
# setcap lets the unprivileged `node` user open raw HCI sockets. Only NET_RAW:
# it is in Docker's default capability set, and a file capability the
# container lacks would make every exec of node fail with EPERM.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libudev1 libcap2-bin \
 && setcap cap_net_raw+eip "$(readlink -f "$(command -v node)")" \
 && apt-get purge -y libcap2-bin && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o node -g node -m 0750 /var/lib/pihumtemp
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/var/lib/pihumtemp/pihumtemp.db
# The database lives here; mount a volume or host directory to persist it.
VOLUME ["/var/lib/pihumtemp"]
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
