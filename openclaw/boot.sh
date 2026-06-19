#!/bin/sh
set -e
mkdir -p /data
cp -f /defaults/openclaw.json /data/openclaw.json

export OPENCLAW_STATE_DIR=/data

# Agent workspace on volume (fixes WorkspaceVanishedError after restarts).
mkdir -p /data/workspace
if [ ! -f /data/workspace/BOOTSTRAP.md ]; then
  rm -rf /data/workspace-attestations 2>/dev/null || true
fi

# Official WhatsApp plugin (trusted install for openKeyedStore).
if ! ls /data/npm/projects/openclaw-whatsapp-*/node_modules/@openclaw/whatsapp/dist/index.js >/dev/null 2>&1; then
  echo "[harvey-claw] installing official @openclaw/whatsapp (may take 2-3 min)..."
  rm -rf /data/extensions/whatsapp /data/npm/projects/openclaw-whatsapp-* 2>/dev/null || true
  openclaw plugins install --force npm:@openclaw/whatsapp || echo "[harvey-claw] WARNING: whatsapp install failed"
fi
openclaw plugins enable whatsapp 2>/dev/null || true
chown -R root:root /data/extensions 2>/dev/null || true

echo "[harvey-claw] synced /data/openclaw.json from image"
grep allowFrom /data/openclaw.json || true

if command -v openclaw >/dev/null 2>&1; then
  exec openclaw gateway
fi
if [ -f /app/dist/index.js ]; then
  exec node /app/dist/index.js
fi
echo "[harvey-claw] could not find openclaw entrypoint"
exit 1
