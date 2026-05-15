#!/usr/bin/env bash
set -euo pipefail

# screenshot.sh — Hyprland screenshots
# Requires: grim, slurp, wl-copy, hyprctl, jq. Optional: swappy, notify-send.

mode="${1:-region}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }; }
need grim
need wl-copy
need hyprctl
need jq

notify() {
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "Screenshot" "$1" || true
  fi
}

out_dir="$HOME/Pictures/Screenshots"
mkdir -p "$out_dir"

ts=$(date +%Y%m%d-%H%M%S)

copy_png() {
  local file="$1"
  wl-copy --type image/png < "$file" 2>/dev/null || wl-copy < "$file"
}

shot_region() {
  need slurp
  local sel
  sel=$(slurp)
  local file="$out_dir/region-$ts.png"
  grim -g "$sel" "$file"
  copy_png "$file"
  notify "Saved and copied: $(basename "$file")"
}

shot_full() {
  local file="$out_dir/full-$ts.png"
  grim "$file"
  copy_png "$file"
  notify "Saved and copied: $(basename "$file")"
}

shot_window() {
  local j x y w h region file
  j=$(hyprctl activewindow -j)
  x=$(jq -r '.at[0]' <<<"$j")
  y=$(jq -r '.at[1]' <<<"$j")
  w=$(jq -r '.size[0]' <<<"$j")
  h=$(jq -r '.size[1]' <<<"$j")
  region="${x},${y} ${w}x${h}"
  file="$out_dir/window-$ts.png"
  grim -g "$region" "$file"
  copy_png "$file"
  notify "Saved and copied: $(basename "$file")"
}

shot_edit() {
  need slurp
  if ! command -v swappy >/dev/null 2>&1; then
    echo "missing: swappy (install it or use region/full/window)" >&2
    exit 1
  fi
  local sel
  sel=$(slurp)
  grim -g "$sel" - | swappy -f -
}

case "$mode" in
  region) shot_region ;;
  full)   shot_full   ;;
  window) shot_window ;;
  edit)   shot_edit   ;;
  *)
    echo "usage: $0 {region|full|window|edit}" >&2
    exit 2
    ;;
esac
