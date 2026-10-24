#!/bin/sh
# Starts as root only to make the data directory writable (a host bind mount is
# often created root-owned by Docker), then drops to the unprivileged `node` user.
set -eu

DATA_DIR="$(dirname "${DB_PATH:-/var/lib/pihumtemp/pihumtemp.db}")"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ -n "$(find "$DATA_DIR" ! -user node -print -quit)" ]; then
    echo "pihumtemp: giving uid $(id -u node) ownership of $DATA_DIR"
    chown -R node:node "$DATA_DIR"
  fi
  # node has file capability cap_net_raw, so the exec regains just that.
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
