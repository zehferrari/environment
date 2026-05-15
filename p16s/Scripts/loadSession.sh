#!/usr/bin/env bash
set -euo pipefail

# loadSession.sh
# - Gracefully close selected browsers (to avoid session corruption)
# - Re-open them on specific Hyprland workspaces
#
# Targets:
#   PhpStorm  -> workspace 1 (DP-4)
#   Chromium  -> workspace 3 (DP-6)
#   Firefox   -> workspace 5 (DP-3)
#   Brave     -> workspace 7 (HDMI-A-2)
#   Chrome    -> workspace 9 (HDMI-A-3)
#   Warp      -> workspace 10 (HDMI-A-3)

log() { printf '[loadSession] %s\n' "$*"; }
err() { printf '[loadSession] ERROR: %s\n' "$*" >&2; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "Missing required command: $1"; exit 1; }
}

need_cmd hyprctl
need_cmd jq

# Mode selection: default to soft (non-disruptive) mode.
#   soft (default): do NOT close apps; just ensure displays and place/launch apps.
#   hard: close apps, then relaunch them on the target workspaces.
MODE="soft"
if [[ "${1:-}" == "--hard" ]]; then
  MODE="hard"
elif [[ "${1:-}" == "--soft" ]]; then
  MODE="soft"
elif [[ "${1:-}" != "" ]]; then
  err "Unknown argument: $1"
  exit 1
fi

log "Starting in $MODE mode..."

ensure_workspace_active() {
  local ws="$1"
  local timeout_s="${2:-3}"

  hyprctl dispatch workspace "$ws" >/dev/null 2>&1 || true

  local start now current
  start=$(date +%s)
  while true; do
    current=$(hyprctl activeworkspace -j | jq -r '.id' 2>/dev/null || echo "")
    if [[ "$current" == "$ws" ]]; then
      return 0
    fi
    now=$(date +%s)
    if (( now - start >= timeout_s )); then
      return 1
    fi
    sleep 0.1
  done
}

# Resolve a runnable command name (first existing wins)
resolve_cmd() {
  local c
  for c in "$@"; do
    if command -v "$c" >/dev/null 2>&1; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

# Close Hyprland windows matching class regex (best-effort graceful close)
close_windows_by_class_regex() {
  local class_regex="$1"

  # Collect window addresses for matching clients
  local addrs
  addrs=$(hyprctl clients -j | jq -r --arg re "$class_regex" '.[] | select(.class|test($re;"i")) | .address')

  if [[ -z "$addrs" ]]; then
    return 0
  fi

  while IFS= read -r addr; do
    [[ -z "$addr" ]] && continue
    # closewindow expects address:<hex>
    hyprctl dispatch closewindow "address:$addr" >/dev/null 2>&1 || true
  done <<< "$addrs"
}

# Wait until no Hyprland windows match class regex (returns 0 if gone)
wait_no_windows_by_class_regex() {
  local class_regex="$1"
  local timeout_s="$2"

  local start now
  start=$(date +%s)

  while true; do
    if ! hyprctl clients -j | jq -e --arg re "$class_regex" 'any(.[]; .class|test($re;"i"))' >/dev/null; then
      return 0
    fi
    now=$(date +%s)
    if (( now - start >= timeout_s )); then
      return 1
    fi
    sleep 0.2
  done
}

# Check if any Hyprland window matches class regex.
has_window_for_class_regex() {
  local class_regex="$1"

  if hyprctl clients -j | jq -e --arg re "$class_regex" 'any(.[]; .class|test($re;"i"))' >/dev/null; then
    return 0
  fi
  return 1
}

# Move the first window matching class regex to the given workspace (best-effort).
move_first_window_of_class_to_workspace() {
  local class_regex="$1"
  local ws="$2"

  local addr
  addr=$(hyprctl clients -j | jq -r --arg re "$class_regex" '.[] | select(.class|test($re;"i")) | .address' 2>/dev/null | head -n1 || true)
  [[ -z "$addr" ]] && return 0

  hyprctl dispatch movetoworkspace "$ws,address:$addr" >/dev/null 2>&1 || true
}


# Gracefully close an app by:
# 1) Closing its windows via Hyprland (WM close)
# 2) Waiting for windows to disappear
#
# We avoid SIGKILL to reduce risk of session/profile corruption.
close_app_gracefully() {
  local name="$1"
  local class_regex="$2"
  local timeout_s="${3:-25}"

  log "Closing $name…"

  close_windows_by_class_regex "$class_regex"

  if ! wait_no_windows_by_class_regex "$class_regex" "$timeout_s"; then
    err "$name windows did not close within ${timeout_s}s. Please close them manually."
    return 1
  fi

  log "$name closed."
}

launch_on_workspace() {
  local ws="$1"
  shift
  local cmd=("$@")

  # Best-effort: ask Hyprland to switch, but don't abort if it fails.
  if ! ensure_workspace_active "$ws" 3; then
    err "Failed to confirm workspace $ws active; launching anyway."
  fi

  log "Launching on workspace $ws: ${cmd[*]}"
  hyprctl dispatch exec "[workspace ${ws}] ${cmd[*]}" >/dev/null 2>&1 || true
}

# Dedicated helper for PhpStorm to be extra tolerant
launch_phpstorm_ws1() {
  if [[ -z "$PHPSTORM_CMD" ]]; then
    err "PHPSTORM_CMD is empty; cannot launch PhpStorm."
    return 1
  fi
  log "Launching PhpStorm on workspace 1: $PHPSTORM_CMD"
  hyprctl dispatch exec "[workspace 1] $PHPSTORM_CMD" >/dev/null 2>&1 || true
}

# Commands (best-effort; only launch if installed)
CHROME_CMD=""
FIREFOX_CMD=""
CHROMIUM_CMD=""
BRAVE_CMD=""
PHPSTORM_CMD=""
WARP_CMD=""

# Whether each app should be relaunched after the close phase
LAUNCH_CHROME=0
LAUNCH_FIREFOX=0
LAUNCH_CHROMIUM=0
LAUNCH_BRAVE=0
LAUNCH_WARP=0
LAUNCH_PHPSTORM=0

CHROME_CMD=$(resolve_cmd google-chrome-stable google-chrome chrome || true)
FIREFOX_CMD=$(resolve_cmd firefox || true)
CHROMIUM_CMD=$(resolve_cmd chromium-browser chromium || true)
BRAVE_CMD=$(resolve_cmd brave-browser brave || true)

# JetBrains Toolbox (PhpStorm) usually installs under ~/.local/share/JetBrains/Toolbox/apps/
if [[ -x "$HOME/.local/share/JetBrains/Toolbox/apps/phpstorm/bin/phpstorm" ]]; then
  PHPSTORM_CMD="$HOME/.local/share/JetBrains/Toolbox/apps/phpstorm/bin/phpstorm"
else
  shopt -s nullglob
  for p in \
    "$HOME/.local/share/JetBrains/Toolbox/apps/phpstorm/ch-"*/bin/phpstorm \
    "$HOME/.local/share/JetBrains/Toolbox/apps/phpstorm/ch-"*/*/bin/phpstorm
  do
    if [[ -x "$p" ]]; then
      PHPSTORM_CMD="$p"
      break
    fi
  done
  shopt -u nullglob
  [[ -n "$PHPSTORM_CMD" ]] || PHPSTORM_CMD=$(resolve_cmd phpstorm || true)
fi

# Warp is usually installed at a fixed path on this machine
if [[ -x /opt/warpdotdev/warp-terminal/warp ]]; then
  WARP_CMD=/opt/warpdotdev/warp-terminal/warp
else
  WARP_CMD=$(resolve_cmd warp || true)
fi

clear_firefox_crash_recovery() {
  # Remove crash-recovery markers so Firefox won't show a restore prompt.
  # This does NOT change your configured startup/home pages.
  local base="$HOME/.mozilla/firefox"
  local ini="$base/profiles.ini"

  [[ -d "$base" ]] || return 0

  local -a profiles=()
  if [[ -f "$ini" ]]; then
    while IFS= read -r p; do
      [[ -z "$p" ]] && continue
      if [[ "$p" = /* ]]; then
        profiles+=("$p")
      else
        profiles+=("$base/$p")
      fi
    done < <(awk -F= '/^Path=/{print $2}' "$ini")
  fi

  # Fallback: try all subdirs if profiles.ini isn't present/parseable
  if (( ${#profiles[@]} == 0 )); then
    profiles=("$base"/*)
  fi

  local prof f
  for prof in "${profiles[@]}"; do
    [[ -d "$prof" ]] || continue
    shopt -s nullglob
    # Remove recovery snapshots so Firefox does not attempt to restore a crashed session.
    for f in "$prof"/sessionstore-backups/recovery*.jsonlz4 "$prof"/sessionstore-backups/recovery*.baklz4; do
      rm -f -- "$f" 2>/dev/null || true
    done
    # Also drop the main sessionstore so that a badly crashed session does not keep
    # triggering the "session is broken" page.
    for f in "$prof"/sessionstore.jsonlz4 "$prof"/sessionstore.js; do
      rm -f -- "$f" 2>/dev/null || true
    done
    shopt -u nullglob
  done
}

# Class regexes (Hyprland client .class values)
CHROME_CLASS_RE='^(google-chrome|google-chrome-stable|chrome)$'
CHROMIUM_CLASS_RE='^(chromium|chromium-browser|Chromium-browser|Chromium)$'
BRAVE_CLASS_RE='^(brave-browser|Brave-browser|Brave)$'
FIREFOX_CLASS_RE='^(firefox|Firefox|org\.mozilla\.firefox)$'
PHPSTORM_CLASS_RE='^(jetbrains-phpstorm|jetbrains-phpstorm-eap|jetbrains-.*phpstorm.*)$'
WARP_CLASS_RE='^(dev\.warp\.Warp)$'


if [[ "$MODE" == "hard" ]]; then
  # Close browsers/IDE/terminal first (only if their command exists)
  if [[ -n "$CHROME_CMD" ]]; then
    if close_app_gracefully "Google Chrome" "$CHROME_CLASS_RE" 30; then
      LAUNCH_CHROME=1
    else
      err "Chrome did not close cleanly; it will not be relaunched automatically."
    fi
  else
    log "Chrome not found; skipping."
  fi

  if [[ -n "$FIREFOX_CMD" ]]; then
    # Firefox usually exits cleanly with window close.
    if close_app_gracefully "Firefox" "$FIREFOX_CLASS_RE" 30; then
      LAUNCH_FIREFOX=1
    else
      err "Firefox did not close cleanly; it will not be relaunched automatically."
    fi
  else
    log "Firefox not found; skipping."
  fi

  if [[ -n "$CHROMIUM_CMD" ]]; then
    if close_app_gracefully "Chromium" "$CHROMIUM_CLASS_RE" 30; then
      LAUNCH_CHROMIUM=1
    else
      err "Chromium did not close cleanly; it will not be relaunched automatically."
    fi
  else
    log "Chromium not found; skipping."
  fi

  if [[ -n "$BRAVE_CMD" ]]; then
    if close_app_gracefully "Brave" "$BRAVE_CLASS_RE" 30; then
      LAUNCH_BRAVE=1
    else
      err "Brave did not close cleanly; it will not be relaunched automatically."
    fi
  else
    log "Brave not found; skipping."
  fi

  if [[ -n "$WARP_CMD" ]]; then
    # Warp usually exits cleanly on WM close.
    if close_app_gracefully "Warp" "$WARP_CLASS_RE" 20; then
      LAUNCH_WARP=1
    else
      err "Warp did not close cleanly; it will not be relaunched automatically."
    fi
  else
    log "Warp not found; skipping."
  fi

  if [[ -n "$PHPSTORM_CMD" ]]; then
    if close_app_gracefully "PhpStorm" "$PHPSTORM_CLASS_RE" 40; then
      LAUNCH_PHPSTORM=1
    else
      log "PhpStorm windows did not close cleanly; force-killing process..."
      pkill -9 -f "phpstorm" || true
      sleep 1
      LAUNCH_PHPSTORM=1
    fi
  else
    log "PhpStorm not found; skipping."
  fi
fi

# Make sure displays are properly set
~/.config/hypr/apply-displays.sh

# Check if a process matching pattern is running
is_process_running() {
  local pattern="$1"
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# Launch/place apps on requested workspaces
# Chromium-family: suppress the "restore session" bubble if the browser thinks it crashed.
if [[ "$MODE" == "hard" ]]; then
  if [[ -n "$CHROMIUM_CMD" && $LAUNCH_CHROMIUM -eq 1 ]]; then
    launch_on_workspace 3 "$CHROMIUM_CMD" --no-first-run --disable-session-crashed-bubble
  fi

  if [[ -n "$FIREFOX_CMD" && $LAUNCH_FIREFOX -eq 1 ]]; then
    clear_firefox_crash_recovery
    launch_on_workspace 5 "$FIREFOX_CMD" --devtools
  fi

  if [[ -n "$BRAVE_CMD" && $LAUNCH_BRAVE -eq 1 ]]; then
    launch_on_workspace 7 "$BRAVE_CMD" --no-first-run --disable-session-crashed-bubble
  fi

  if [[ -n "$CHROME_CMD" && $LAUNCH_CHROME -eq 1 ]]; then
    launch_on_workspace 9 "$CHROME_CMD" --no-first-run --disable-session-crashed-bubble
  fi

  if [[ -n "$WARP_CMD" && $LAUNCH_WARP -eq 1 ]]; then
    launch_on_workspace 10 "$WARP_CMD"
  fi

  # Launch PhpStorm last (as requested)
  if [[ -n "$PHPSTORM_CMD" && $LAUNCH_PHPSTORM -eq 1 ]]; then
    sleep 1  # Brief delay to ensure PhpStorm process is fully terminated
    launch_phpstorm_ws1
  else
    log "PhpStorm launch skipped: PHPSTORM_CMD='$PHPSTORM_CMD', LAUNCH_PHPSTORM=$LAUNCH_PHPSTORM"
  fi

# Soft mode: do not close anything. Ensure apps exist and are on desired workspaces.
elif [[ "$MODE" == "soft" ]]; then


  # Chromium
  if is_process_running "chromium"; then
    log "Chromium is running; checking for windows..."
    if has_window_for_class_regex "$CHROMIUM_CLASS_RE"; then
      move_first_window_of_class_to_workspace "$CHROMIUM_CLASS_RE" 3
    else
      launch_on_workspace 3 "$CHROMIUM_CMD"
    fi
  else
    launch_on_workspace 3 "$CHROMIUM_CMD" --no-first-run --disable-session-crashed-bubble
  fi

  # Firefox
  if is_process_running "firefox"; then
    log "Firefox is running; checking for windows..."
    if has_window_for_class_regex "$FIREFOX_CLASS_RE"; then
      move_first_window_of_class_to_workspace "$FIREFOX_CLASS_RE" 5
    else
      log "Firefox running but no window found (possible zombie/headless). Killing process to ensure clean launch..."
      pkill -f "firefox" || true
      sleep 1
      clear_firefox_crash_recovery
      launch_on_workspace 5 "$FIREFOX_CMD" --devtools
    fi
  else
    log "Firefox not running; launching..."
    clear_firefox_crash_recovery
    launch_on_workspace 5 "$FIREFOX_CMD" --devtools
  fi

  # Brave
  if is_process_running "brave"; then
    log "Brave is running; checking for windows..."
    if has_window_for_class_regex "$BRAVE_CLASS_RE"; then
      move_first_window_of_class_to_workspace "$BRAVE_CLASS_RE" 7
    else
      launch_on_workspace 7 "$BRAVE_CMD"
    fi
  else
    launch_on_workspace 7 "$BRAVE_CMD" --no-first-run --disable-session-crashed-bubble
  fi

  # Chrome
  if is_process_running "chrome"; then
    log "Chrome is running; checking for windows..."
    if has_window_for_class_regex "$CHROME_CLASS_RE"; then
      move_first_window_of_class_to_workspace "$CHROME_CLASS_RE" 9
    else
      launch_on_workspace 9 "$CHROME_CMD"
    fi
  else
    launch_on_workspace 9 "$CHROME_CMD" --no-first-run --disable-session-crashed-bubble
  fi

  # Warp
  if is_process_running "warp"; then
    log "Warp is running; checking for windows..."
    if has_window_for_class_regex "$WARP_CLASS_RE"; then
      move_first_window_of_class_to_workspace "$WARP_CLASS_RE" 10
    else
      launch_on_workspace 10 "$WARP_CMD"
    fi
  else
    launch_on_workspace 10 "$WARP_CMD"
  fi

# PhpStorm
if is_process_running "phpstorm"; then
  log "PhpStorm is running; checking for windows..."
  if has_window_for_class_regex "$PHPSTORM_CLASS_RE"; then
    move_first_window_of_class_to_workspace "$PHPSTORM_CLASS_RE" 1
  else
    log "PhpStorm process found but no window present. Killing stale process and relaunching..."
    pkill -f "phpstorm" || true
    sleep 1
    launch_phpstorm_ws1
  fi
else
  launch_phpstorm_ws1
fi

fi

log "Done."
