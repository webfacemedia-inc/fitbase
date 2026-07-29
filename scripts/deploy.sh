#!/usr/bin/env bash
# FitBase deploy. Because fitbase runs the `custom` template, the platform's git
# webhook is intentionally skipped for it (startGitDeploy returns early for
# template=custom) — a custom-template app owns its own deploy. This script is
# that path: build + ship the Go binary, then sync the SPA into pb_public.
#
#   scripts/deploy.sh                 # build binary + restart + sync frontend
#   scripts/deploy.sh --frontend-only # just sync public/ (no binary rebuild)
#
# Requires: the webface-cloud checkout beside this repo (../webface-cloud, for
# the pbbrand import) and SSH access to the droplet.
set -euo pipefail

DROPLET=root@137.184.160.83
APPDIR=/srv/platform/apps/fitbase
BIN=/srv/platform/binaries/fitbase
cd "$(dirname "$0")/.."   # repo root

if [[ "${1:-}" != "--frontend-only" ]]; then
  echo "→ building linux/amd64 binary…"
  ( cd server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /tmp/fitbase-linux . )
  scp -q /tmp/fitbase-linux "$DROPLET:$BIN"
  ssh "$DROPLET" "chmod +x $BIN && systemctl restart wfc-fitbase && sleep 2 && systemctl is-active wfc-fitbase"
  echo "→ binary shipped + service restarted"
fi

echo "→ syncing frontend (public/ → pb_public)…"
tar czf /tmp/fb-public.tgz -C public .
scp -q /tmp/fb-public.tgz "$DROPLET:/tmp/fb-public.tgz"
ssh "$DROPLET" "set -e
  rm -rf /tmp/fb-new && mkdir -p /tmp/fb-new && tar xzf /tmp/fb-public.tgz -C /tmp/fb-new
  rm -rf '$APPDIR/pb_public.prev'; cp -a '$APPDIR/pb_public' '$APPDIR/pb_public.prev'
  rm -rf '$APPDIR'/pb_public/*; cp -a /tmp/fb-new/. '$APPDIR'/pb_public/
  chown -R wfc-fitbase:wfc-fitbase '$APPDIR/pb_public'
  rm -rf /tmp/fb-new /tmp/fb-public.tgz"
echo "→ done: https://fitbase.webface.cloud"
