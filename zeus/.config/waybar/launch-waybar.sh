#!/usr/bin/env bash
set -euo pipefail

# Start Waybar on the Dell monitor, even if connector names change.
# We match by Hyprland's monitor EDID description.

if ! command -v jq >/dev/null 2>&1; then
  exec waybar
fi

CONFIG="/home/zeh/.config/waybar/config"
STYLE="/home/zeh/.config/waybar/style.css"
DELL_DESC_SUBSTR="DELL U2421E"

# Wait for Hyprland + outputs to be ready.
for _ in $(seq 1 40); do
  if hyprctl monitors -j >/dev/null 2>&1; then
    if hyprctl monitors -j | jq -e --arg s "${DELL_DESC_SUBSTR}" '.[] | select(.description | contains($s))' >/dev/null; then
      break
    fi
  fi
  sleep 0.25
done

output=$(hyprctl monitors -j | jq -r --arg s "${DELL_DESC_SUBSTR}" '.[] | select(.description | contains($s)) | .name' | head -n1)

# If not found, fall back to the default config behavior.
if [ -z "${output}" ]; then
  exec waybar -c "${CONFIG}" -s "${STYLE}"
fi

# Write a temporary config with the correct output.
# (Waybar supports comments in config; we just replace the first "output" key we find.)
tmpdir="${XDG_RUNTIME_DIR:-/tmp}"
tmpcfg="${tmpdir}/waybar-config-${output}.jsonc"

perl -pe 's/^\s*"output"\s*:\s*"[^"]*"\s*,/    "output": "'"${output}"'",/' "${CONFIG}" > "${tmpcfg}"

exec waybar -c "${tmpcfg}" -s "${STYLE}"