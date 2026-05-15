#!/usr/bin/env bash
# Fetch high-quality popular Unsplash photos and apply per-monitor via hyprpaper.

set -euo pipefail

THEME="${1:-popular}" # kept for compatibility; ignored when popular feed is used
OUTDIR="$HOME/.cache/hyprpaper-unsplash"
CONF_PATH="$HOME/.config/hypr/hyprpaper.conf"
API_URL_LIST="https://api.unsplash.com/photos"

for dep in curl jq hyprctl hyprpaper; do
  command -v "$dep" >/dev/null 2>&1 || { echo "Missing dependency: $dep" >&2; exit 1; }
done

: "${UNSPLASH_ACCESS_KEY:?Set UNSPLASH_ACCESS_KEY in your environment}"

mkdir -p "$OUTDIR"

mapfile -t MONITORS < <(hyprctl monitors -j | jq -r '.[].name')
if [ ${#MONITORS[@]} -eq 0 ]; then
  echo "No monitors found via hyprctl." >&2
  exit 1
fi

TMP_CONF="$(mktemp)"
{
  echo "# Auto-generated $(date -Iseconds) by hyprpaper-unsplash.sh source=popular"
  echo "splash = false"
} > "$TMP_CONF"

for mon in "${MONITORS[@]}"; do
  RESP="$(curl -s -H "Authorization: Client-ID ${UNSPLASH_ACCESS_KEY}" \
    --get "$API_URL_LIST" \
    --data-urlencode "page=1" \
    --data-urlencode "per_page=30" \
    --data-urlencode "order_by=popular" \
    --data-urlencode "content_filter=high")"

  COUNT="$(printf '%s' "$RESP" | jq 'length')"
  [ "$COUNT" -gt 0 ] || { echo "Unsplash returned no photos. Response: $RESP" >&2; exit 1; }

  INDEX=$((RANDOM % COUNT))
  URL="$(printf '%s' "$RESP" | jq -r --argjson i "$INDEX" '.[$i].urls.raw // empty')"
  [ -n "$URL" ] || { echo "Unsplash returned empty URL. Response: $RESP" >&2; exit 1; }

  IMG="$OUTDIR/${mon}.jpg"
  curl -sL "${URL}&w=5120&h=3200&fm=jpg&q=95" -o "$IMG"

  echo "preload = $IMG"   >> "$TMP_CONF"
  echo "wallpaper = ${mon},$IMG" >> "$TMP_CONF"
done

mv "$TMP_CONF" "$CONF_PATH"

# Restart hyprpaper to apply
pkill -x hyprpaper 2>/dev/null || true
hyprpaper >/dev/null 2>&1 &

echo "Applied Unsplash theme '$THEME' to ${#MONITORS[@]} monitor(s). Config: $CONF_PATH"
