#!/usr/bin/env bash
set -euo pipefail

# loadSession.sh
# - Gracefully close selected browsers/editors (to avoid session corruption)
# - Re-open them on specific Hyprland workspaces
#
# Targets (launch order matters: Firefox before Sublime so Sublime tiles right):
#   Chromium             -> workspace 1 (DP-4)
#   Kitty                -> workspace 3 (DP-6)
#   Firefox + Sublime    -> workspace 5 (DP-3) — Sublime tiled on the right
#   Brave                -> workspace 7 (HDMI-A-2)
#   Chrome               -> workspace 9 (HDMI-A-3)

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

# ---------------------------------------------------------------------------
# Generic helpers (app-agnostic)
# ---------------------------------------------------------------------------

# Resolve a runnable command name (first existing wins). Echoes "" if none.
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

# Echo the addresses of all Hyprland clients whose class matches a regex.
client_addrs_by_class() {
  local class_regex="$1"
  hyprctl clients -j | jq -r --arg re "$class_regex" '.[] | select(.class|test($re;"i")) | .address'
}

# True (0) if any Hyprland window matches the class regex.
has_window_for_class_regex() {
  hyprctl clients -j | jq -e --arg re "$1" 'any(.[]; .class|test($re;"i"))' >/dev/null
}

# Switch to a workspace and wait (best-effort) until it is active.
ensure_workspace_active() {
  local ws="$1" timeout_s="${2:-3}" start now current
  hyprctl dispatch workspace "$ws" >/dev/null 2>&1 || true
  start=$(date +%s)
  while true; do
    current=$(hyprctl activeworkspace -j | jq -r '.id' 2>/dev/null || echo "")
    [[ "$current" == "$ws" ]] && return 0
    now=$(date +%s)
    (( now - start >= timeout_s )) && return 1
    sleep 0.1
  done
}

# Close every window matching a class regex (best-effort graceful WM close).
close_windows_by_class_regex() {
  local addr
  while IFS= read -r addr; do
    [[ -z "$addr" ]] && continue
    hyprctl dispatch closewindow "address:$addr" >/dev/null 2>&1 || true
  done < <(client_addrs_by_class "$1")
}

# Wait until no window matches the class regex (0 if gone within timeout).
wait_no_windows_by_class_regex() {
  local class_regex="$1" timeout_s="$2" start now
  start=$(date +%s)
  while true; do
    has_window_for_class_regex "$class_regex" || return 0
    now=$(date +%s)
    (( now - start >= timeout_s )) && return 1
    sleep 0.2
  done
}

# Wait until a window of the class regex exists (0 if it appears within timeout).
wait_for_window_of_class() {
  local class_regex="$1" timeout_s="${2:-5}" start now
  start=$(date +%s)
  while true; do
    has_window_for_class_regex "$class_regex" && return 0
    now=$(date +%s)
    (( now - start >= timeout_s )) && return 1
    sleep 0.1
  done
}

# Move the first window matching a class regex to a workspace (best-effort).
move_first_window_of_class_to_workspace() {
  local class_regex="$1" ws="$2" addr
  addr=$(client_addrs_by_class "$class_regex" | head -n1 || true)
  [[ -z "$addr" ]] && return 0
  hyprctl dispatch movetoworkspace "$ws,address:$addr" >/dev/null 2>&1 || true
}

# Focus the first window matching a class regex (waiting briefly for it).
# Used so a newly-launched window tiles next to (to the right of) this one.
focus_first_window_of_class() {
  local class_regex="$1" addr
  wait_for_window_of_class "$class_regex" 5 || return 1
  addr=$(client_addrs_by_class "$class_regex" | head -n1 || true)
  [[ -z "$addr" ]] && return 1
  hyprctl dispatch focuswindow "address:$addr" >/dev/null 2>&1 || true
}

# Gracefully close an app: WM-close its windows, then wait for them to vanish.
# Avoids SIGKILL to reduce the risk of session/profile corruption.
close_app_gracefully() {
  local name="$1" class_regex="$2" timeout_s="${3:-25}"
  log "Closing $name…"
  close_windows_by_class_regex "$class_regex"
  if ! wait_no_windows_by_class_regex "$class_regex" "$timeout_s"; then
    err "$name windows did not close within ${timeout_s}s. Please close them manually."
    return 1
  fi
  log "$name closed."
}

# Launch a command on a specific workspace (best-effort).
launch_on_workspace() {
  local ws="$1"; shift
  local cmd=("$@")
  if ! ensure_workspace_active "$ws" 3; then
    err "Failed to confirm workspace $ws active; launching anyway."
  fi
  log "Launching on workspace $ws: ${cmd[*]}"
  hyprctl dispatch exec "[workspace ${ws}] ${cmd[*]}" >/dev/null 2>&1 || true
}

is_process_running() {
  pgrep -f "$1" >/dev/null 2>&1
}

# App-specific pre-launch hook: clear Firefox crash-recovery markers so it does
# not show a "restore session" prompt. Does NOT change startup/home pages.
clear_firefox_crash_recovery() {
  local base="$HOME/.mozilla/firefox"
  local ini="$base/profiles.ini"
  [[ -d "$base" ]] || return 0

  local -a profiles=()
  if [[ -f "$ini" ]]; then
    while IFS= read -r p; do
      [[ -z "$p" ]] && continue
      [[ "$p" = /* ]] && profiles+=("$p") || profiles+=("$base/$p")
    done < <(awk -F= '/^Path=/{print $2}' "$ini")
  fi
  (( ${#profiles[@]} == 0 )) && profiles=("$base"/*)

  local prof f
  for prof in "${profiles[@]}"; do
    [[ -d "$prof" ]] || continue
    shopt -s nullglob
    for f in "$prof"/sessionstore-backups/recovery*.jsonlz4 \
             "$prof"/sessionstore-backups/recovery*.baklz4 \
             "$prof"/sessionstore.jsonlz4 "$prof"/sessionstore.js; do
      rm -f -- "$f" 2>/dev/null || true
    done
    shopt -u nullglob
  done
}

# ---------------------------------------------------------------------------
# App registry — single source of truth. Add/edit an app here only.
#   APPS                 ordered list of ids (launch order; ws-ascending,
#                        and Firefox before Sublime so Sublime tiles right)
#   APP_NAME             human-readable name (logs)
#   APP_RESOLVE          candidate executables (first found wins)
#   APP_CLASS_RE         Hyprland client .class regex
#   APP_WS               target workspace
#   APP_PROC             pgrep -f pattern (soft mode "is it running?")
#   APP_ARGS             extra launch args (space-separated; optional)
#   APP_CLOSE_TIMEOUT    graceful-close timeout, seconds (default 25)
#   APP_PREHOOK          function to run right before launching (optional)
#   APP_FOCUS_BEFORE     focus a window of this class regex before launching,
#                        so the new window tiles to its right (optional)
#   APP_KILL_ZOMBIE      1 = if running but window-less, kill before relaunch
# ---------------------------------------------------------------------------
CHROME_CLASS_RE='^(google-chrome|google-chrome-stable|chrome)$'
CHROMIUM_CLASS_RE='^(chromium|chromium-browser|Chromium-browser|Chromium)$'
BRAVE_CLASS_RE='^(brave-browser|Brave-browser|Brave)$'
FIREFOX_CLASS_RE='^(firefox|Firefox|org\.mozilla\.firefox)$'
SUBLIME_CLASS_RE='^(sublime_text|Sublime_text|subl)$'
KITTY_CLASS_RE='^(kitty|Kitty)$'

APPS=(chromium kitty firefox sublime brave chrome)

declare -A APP_NAME APP_RESOLVE APP_CLASS_RE APP_WS APP_PROC \
           APP_ARGS APP_CLOSE_TIMEOUT APP_PREHOOK APP_FOCUS_BEFORE \
           APP_KILL_ZOMBIE APP_CMD APP_LAUNCH

CRASH_FLAGS='--no-first-run --disable-session-crashed-bubble'

# Chromium
APP_NAME[chromium]='Chromium'
APP_RESOLVE[chromium]='chromium-browser chromium'
APP_CLASS_RE[chromium]="$CHROMIUM_CLASS_RE"
APP_WS[chromium]=1
APP_PROC[chromium]='chromium'
APP_ARGS[chromium]="$CRASH_FLAGS"
APP_CLOSE_TIMEOUT[chromium]=30

# Kitty
APP_NAME[kitty]='Kitty'
APP_RESOLVE[kitty]='kitty'
APP_CLASS_RE[kitty]="$KITTY_CLASS_RE"
APP_WS[kitty]=3
APP_PROC[kitty]='kitty'
APP_CLOSE_TIMEOUT[kitty]=20

# Firefox (left half of workspace 5)
APP_NAME[firefox]='Firefox'
APP_RESOLVE[firefox]='firefox'
APP_CLASS_RE[firefox]="$FIREFOX_CLASS_RE"
APP_WS[firefox]=5
APP_PROC[firefox]='firefox'
APP_CLOSE_TIMEOUT[firefox]=30
APP_PREHOOK[firefox]='clear_firefox_crash_recovery'
APP_KILL_ZOMBIE[firefox]=1

# Sublime Text (right half of workspace 5 — focus Firefox first so it tiles right)
APP_NAME[sublime]='Sublime Text'
APP_RESOLVE[sublime]='subl sublime_text subl3'
APP_CLASS_RE[sublime]="$SUBLIME_CLASS_RE"
APP_WS[sublime]=5
APP_PROC[sublime]='sublime_text'
APP_CLOSE_TIMEOUT[sublime]=30
APP_FOCUS_BEFORE[sublime]="$FIREFOX_CLASS_RE"

# Brave
APP_NAME[brave]='Brave'
APP_RESOLVE[brave]='brave-browser brave'
APP_CLASS_RE[brave]="$BRAVE_CLASS_RE"
APP_WS[brave]=7
APP_PROC[brave]='brave'
APP_ARGS[brave]="$CRASH_FLAGS"
APP_CLOSE_TIMEOUT[brave]=30

# Chrome
APP_NAME[chrome]='Google Chrome'
APP_RESOLVE[chrome]='google-chrome-stable google-chrome chrome'
APP_CLASS_RE[chrome]="$CHROME_CLASS_RE"
APP_WS[chrome]=9
APP_PROC[chrome]='chrome'
APP_ARGS[chrome]="$CRASH_FLAGS"
APP_CLOSE_TIMEOUT[chrome]=30

# Resolve every app's command up front (empty => not installed => skipped).
for id in "${APPS[@]}"; do
  APP_CMD[$id]=$(resolve_cmd ${APP_RESOLVE[$id]} || true)
  APP_LAUNCH[$id]=0
done

# ---------------------------------------------------------------------------
# Per-app operations (driven entirely by the registry above)
# ---------------------------------------------------------------------------

run_prehook() {
  local hook="${APP_PREHOOK[$1]:-}"
  [[ -n "$hook" ]] && "$hook"
  return 0
}

focus_before_launch() {
  local re="${APP_FOCUS_BEFORE[$1]:-}"
  [[ -n "$re" ]] && focus_first_window_of_class "$re"
  return 0
}

do_launch() {
  local id="$1"
  run_prehook "$id"
  focus_before_launch "$id"
  launch_on_workspace "${APP_WS[$id]}" "${APP_CMD[$id]}" ${APP_ARGS[$id]:-}
}

# hard mode: close the app and arm it for relaunch if it closed cleanly.
close_app() {
  local id="$1"
  local name="${APP_NAME[$id]}"
  if [[ -z "${APP_CMD[$id]}" ]]; then
    log "$name not found; skipping."
    return 0
  fi
  if close_app_gracefully "$name" "${APP_CLASS_RE[$id]}" "${APP_CLOSE_TIMEOUT[$id]:-25}"; then
    APP_LAUNCH[$id]=1
  else
    err "$name did not close cleanly; it will not be relaunched automatically."
  fi
}

# hard mode: relaunch only apps that were closed cleanly above.
relaunch_app() {
  local id="$1"
  [[ -n "${APP_CMD[$id]}" && "${APP_LAUNCH[$id]}" -eq 1 ]] || return 0
  do_launch "$id"
}

# soft mode: don't close anything. If running with a window, move it to its
# workspace; otherwise (re)launch it there.
place_or_launch_app() {
  local id="$1"
  local name="${APP_NAME[$id]}"
  local re="${APP_CLASS_RE[$id]}"
  if [[ -z "${APP_CMD[$id]}" ]]; then
    log "$name not found; skipping."
    return 0
  fi

  if is_process_running "${APP_PROC[$id]}"; then
    log "$name is running; checking for windows..."
    if has_window_for_class_regex "$re"; then
      move_first_window_of_class_to_workspace "$re" "${APP_WS[$id]}"
      return 0
    fi
    # Running but no window (zombie/headless).
    if [[ "${APP_KILL_ZOMBIE[$id]:-0}" -eq 1 ]]; then
      log "$name running but no window found; killing stale process for a clean launch..."
      pkill -f "${APP_PROC[$id]}" || true
      sleep 1
    fi
  else
    log "$name not running; launching..."
  fi

  do_launch "$id"
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

# hard mode: close phase first (so relaunches start from a clean state).
if [[ "$MODE" == "hard" ]]; then
  for id in "${APPS[@]}"; do
    close_app "$id"
  done
fi

# Make sure displays are properly set before placing windows.
~/.config/hypr/apply-displays.sh

# Launch/place phase.
for id in "${APPS[@]}"; do
  if [[ "$MODE" == "hard" ]]; then
    relaunch_app "$id"
  else
    place_or_launch_app "$id"
  fi
done

log "Done."
