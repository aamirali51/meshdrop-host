#!/bin/sh
set -e

# Drop privileges to PUID:PGID when started as root (the Syncthing/NAS
# convention), so files created in the mounted volumes are owned by the host
# user rather than root.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  if ! getent group "$PGID" >/dev/null 2>&1; then
    groupadd -g "$PGID" meshdrop
  fi
  if ! getent passwd "$PUID" >/dev/null 2>&1; then
    useradd -u "$PUID" -g "$PGID" -M -s /usr/sbin/nologin meshdrop
  fi
  mkdir -p "${MESHDROP_HOST_STORAGE:-/data}" "${MESHDROP_HOST_DOWNLOADS:-/downloads}"
  chown -R "$PUID:$PGID" "${MESHDROP_HOST_STORAGE:-/data}" "${MESHDROP_HOST_DOWNLOADS:-/downloads}"
  exec gosu "$PUID:$PGID" "$@"
fi

exec "$@"
