#!/usr/bin/env bash
set -euo pipefail

CONFIG="/home/zeh/.config/waybar/config"
STYLE="/home/zeh/.config/waybar/style.css"

exec waybar -c "${CONFIG}" -s "${STYLE}"
