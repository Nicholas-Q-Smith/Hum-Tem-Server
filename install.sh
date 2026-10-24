#!/usr/bin/env bash
# Installs or updates pihumtemp on Raspberry Pi OS. Safe to re-run.
#   sudo ./install.sh
set -euo pipefail

APP_DIR=/opt/pihumtemp
DATA_DIR=/var/lib/pihumtemp
ENV_FILE=/etc/default/pihumtemp
UNIT=/etc/systemd/system/pihumtemp.service
SVC_USER=pihumtemp
NODE_MAJOR=22
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

log "Installing apt packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq bluetooth bluez libbluetooth-dev libudev-dev build-essential \
  python3 rsync sqlite3 libcap2-bin ca-certificates curl >/dev/null

node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if (( $(node_major) < NODE_MAJOR )); then
  log "Installing Node.js ${NODE_MAJOR}.x from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs >/dev/null
fi
log "Using node $(node -v) at $(readlink -f "$(command -v node)")"

log "Creating user ${SVC_USER} and ${DATA_DIR}"
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
fi
usermod -a -G bluetooth "$SVC_USER"
install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$DATA_DIR"

log "Copying app to ${APP_DIR}"
install -d "$APP_DIR"
if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  rsync -a --delete --exclude node_modules --exclude dist --exclude data --exclude .git \
    --exclude '*.db' --exclude '*.db-wal' --exclude '*.db-shm' "$SRC_DIR"/ "$APP_DIR"/
fi

log "Installing dependencies and building (native modules compile on first run; this can take a few minutes)"
cd "$APP_DIR"
npm ci --no-audit --no-fund
npm run build
npm prune --omit=dev --no-audit --no-fund

if [[ ! -f "$ENV_FILE" ]]; then
  log "Creating ${ENV_FILE} from .env.example"
  install -m 0644 "$APP_DIR/.env.example" "$ENV_FILE"
else
  log "Keeping existing ${ENV_FILE}"
fi

log "Installing systemd unit"
sed "s#/usr/bin/node#$(command -v node)#" "$APP_DIR/deploy/pihumtemp.service" > "$UNIT"
systemctl daemon-reload
systemctl enable bluetooth >/dev/null 2>&1 || true
rfkill unblock bluetooth 2>/dev/null || true
systemctl enable pihumtemp
systemctl restart pihumtemp

log "Done. Follow the logs with: journalctl -u pihumtemp -f"
sleep 2
curl -fsS "http://localhost:$(. "$ENV_FILE"; echo "${PORT:-8080}")/api/health" && echo || \
  echo "Health check not answering yet; check journalctl -u pihumtemp" >&2
