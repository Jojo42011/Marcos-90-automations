#!/usr/bin/env bash
# Copy Wesley's Zernio secrets from wesley-dm-ai onto marco-90-automation
# as WESLEY_ZERNIO_* so his Command Center account uses his TikTok DMs/analytics.
#
# Requires: flyctl auth (FLY_API_TOKEN) with access to both apps.
# Does not print secret values.
set -euo pipefail

SRC_APP="${SRC_APP:-wesley-dm-ai}"
DST_APP="${DST_APP:-marco-90-automation}"

need=(ZERNIO_DM_API_KEY ZERNIO_WEBHOOK_SECRET ZERNIO_TIKTOK_ACCOUNT_ID)
echo "Reading secret names from ${SRC_APP}…"
mapfile -t lines < <(flyctl secrets list -a "$SRC_APP" --json | python3 -c 'import json,sys; print("\n".join(s["name"] for s in json.load(sys.stdin)))')
for n in "${need[@]}"; do
  if ! printf '%s\n' "${lines[@]}" | grep -qx "$n"; then
    echo "Missing ${n} on ${SRC_APP}" >&2
    exit 1
  fi
done

echo "Fetching values from ${SRC_APP} (not printed)…"
# flyctl secrets list does not return values; pull via ssh env on a running machine.
raw="$(flyctl ssh console -a "$SRC_APP" -C 'printenv ZERNIO_DM_API_KEY ZERNIO_WEBHOOK_SECRET ZERNIO_TIKTOK_ACCOUNT_ID' 2>/dev/null || true)"
if [[ -z "$raw" ]]; then
  echo "Could not read env from ${SRC_APP} via ssh. Set WESLEY_ZERNIO_* on ${DST_APP} manually." >&2
  exit 1
fi

api_key="$(printf '%s\n' "$raw" | sed -n '1p')"
webhook="$(printf '%s\n' "$raw" | sed -n '2p')"
tiktok="$(printf '%s\n' "$raw" | sed -n '3p')"

if [[ -z "$api_key" || -z "$webhook" || -z "$tiktok" ]]; then
  echo "Incomplete Zernio env on ${SRC_APP}." >&2
  exit 1
fi

echo "Setting WESLEY_ZERNIO_* on ${DST_APP} (values not printed)…"
flyctl secrets set -a "$DST_APP" \
  "WESLEY_ZERNIO_DM_API_KEY=${api_key}" \
  "WESLEY_ZERNIO_WEBHOOK_SECRET=${webhook}" \
  "WESLEY_ZERNIO_TIKTOK_ACCOUNT_ID=${tiktok}"

echo "Done. Confirm Marco's ZERNIO_* secrets remain set on ${DST_APP}."
