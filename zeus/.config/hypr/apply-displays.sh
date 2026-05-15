#!/usr/bin/env bash
set -euo pipefail

# Re-apply monitor layout after login.
# This is meant to fix cases where outputs appear late (or names shuffle) and Hyprland falls back to auto layout.

need_jq() {
  command -v jq >/dev/null 2>&1
}

if ! need_jq; then
  # jq is required for stable matching by EDID description.
  exit 0
fi

# Wait a bit for outputs to appear/settle (e.g. USB-C docks, DP MST).
# With the ZEUSLAP attached you typically have 5 outputs; waiting for 5 avoids missing it if it appears late.
for _ in $(seq 1 40); do
  if hyprctl monitors -j >/dev/null 2>&1; then
    count=$(hyprctl monitors -j | jq 'length')
    if [ "${count}" -ge 5 ]; then
      break
    fi
  fi
  sleep 0.25
done

monitors_json=$(hyprctl monitors -j 2>/dev/null || true)
if [ -z "${monitors_json}" ]; then
  exit 0
fi

# Match monitors by EDID description (stable across connector renames).
name_ultra=$(jq -r '.[] | select(.description == "KOGAN AUSTRALIA PTY LTD KAMN34FXQULA") | .name' <<<"${monitors_json}" | head -n1)
name_left=$(jq -r '.[] | select(.description == "KOGAN AUSTRALIA PTY LTD KAMN27Q18CSA 0000000000000") | .name' <<<"${monitors_json}" | head -n1)
name_dell=$(jq -r '.[] | select(.description == "Dell Inc. DELL U2421E 8TS0YG3") | .name' <<<"${monitors_json}" | head -n1)

# Get both ZUS displays (they have identical descriptions).
# We sort them to make assignment deterministic based on connector name (e.g. HDMI-A-2 vs HDMI-A-3).
# Based on original working config: HDMI-A-3 was Left, HDMI-A-2 was Right.
# So we assume: Higher Connector Name = Left, Lower Connector Name = Right.
zus_names=$(jq -r '.[] | select(.description == "ZUS ZEUSLAP-HDMI 0000000") | .name' <<<"${monitors_json}" | sort)
name_zus_right=$(echo "${zus_names}" | head -n1) # Lower ID (e.g. HDMI-A-2)
name_zus_left=$(echo "${zus_names}" | tail -n1)  # Higher ID (e.g. HDMI-A-3)

# If we can't identify the core expected set, don't try to "fix" anything.
if [ -z "${name_ultra}" ] || [ -z "${name_left}" ] || [ -z "${name_dell}" ] || [ -z "${name_zus_left}" ] || [ -z "${name_zus_right}" ]; then
  exit 0
fi

# Apply layout (positions based on current user preference 2026-01-25)
# Top Row:
# KOGAN 27" (Left): 0x129
# Dell U2421E (Center, Portrait): 2560x129
# KOGAN 34" Ultrawide (Right): 3760x129
# Bottom Row:
# ZEUSLAP higher connector name (Left-ish): 961x1569
# ZEUSLAP lower connector name (Right): 3760x1569
BATCH="keyword monitor ${name_left},2560x1440@60,0x129,1,transform,0,vrr,0; \
keyword monitor ${name_dell},1920x1200@60,2560x129,1,transform,1,vrr,0; \
keyword monitor ${name_ultra},3440x1440@60,3760x129,1,transform,0,vrr,0; \
keyword monitor ${name_zus_left},2560x1600@60,961x1569,1.60,transform,0,vrr,0; \
keyword monitor ${name_zus_right},2560x1600@60,3760x1569,1.60,transform,0,vrr,0;"
hyprctl --batch "${BATCH}" >/dev/null 2>&1 || true

# Ensure workspace-to-monitor placement (best-effort; harmless if some workspaces don't exist yet).
# 2 workspaces per display.
# Requested mapping (via EDID-resolved names):
#   name_left       -> 1,2   (KOGAN 27" Curved)
#   name_dell       -> 3,4   (Dell 24" Portrait)
#   name_ultra      -> 5,6   (KOGAN 34" Ultrawide PRIMARY)
#   name_zus_left   -> 9,10  (ZUS ZEUSLAP-HDMI bottom left-ish)
#   name_zus_right  -> 7,8   (ZUS ZEUSLAP-HDMI bottom right-ish)

# Left KOGAN 27" -> ws 1,2
for ws in 1 2; do
  hyprctl dispatch moveworkspacetomonitor "${ws}" "${name_left}" >/dev/null 2>&1 || true
done

# Dell portrait -> ws 3,4
for ws in 3 4; do
  hyprctl dispatch moveworkspacetomonitor "${ws}" "${name_dell}" >/dev/null 2>&1 || true
done

# KOGAN 34" Ultrawide PRIMARY -> ws 5,6
for ws in 5 6; do
  hyprctl dispatch moveworkspacetomonitor "${ws}" "${name_ultra}" >/dev/null 2>&1 || true
done

# ZUS Left -> ws 9,10
for ws in 9 10; do
  hyprctl dispatch moveworkspacetomonitor "${ws}" "${name_zus_left}" >/dev/null 2>&1 || true
done

# ZUS Right -> ws 7,8
for ws in 7 8; do
  hyprctl dispatch moveworkspacetomonitor "${ws}" "${name_zus_right}" >/dev/null 2>&1 || true
done
