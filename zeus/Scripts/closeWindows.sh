#!/bin/bash

# Set error handling
set -e

# Log function
log() {
    echo "$(date): $1" >> /tmp/shutdown-script.log
    logger -t shutdown-script "$1"
}

# Best-effort process termination with a grace period.
# NOTE: `pgrep -x` matches the kernel "comm" name (often truncated to 15 chars), so this is only
# reliable for short executable names (e.g. firefox, dolphin, warp).
terminate_names() {
    local timeout_s="$1"; shift
    local names=("$@")

    local name
    for name in "${names[@]}"; do
        if pgrep -x "$name" >/dev/null 2>&1; then
            log "Sending SIGTERM to $name"
            pkill -TERM -x "$name" 2>/dev/null || true
        fi
    done

    # Wait for them to exit cleanly (important for browser session writes).
    local start now still_running
    start="$(date +%s)"
    while true; do
        still_running=0
        for name in "${names[@]}"; do
            if pgrep -x "$name" >/dev/null 2>&1; then
                still_running=1
                break
            fi
        done
        if [[ "$still_running" -eq 0 ]]; then
            return 0
        fi

        now="$(date +%s)"
        if (( now - start >= timeout_s )); then
            log "Timeout waiting for $name to exit. Skipping forced kill to preserve data."
            break
        fi
        sleep 1
    done
}

# Terminate processes by matching full command line (regex).
# Use this for long/packaged executables where comm is truncated (e.g. chromium-browser).
terminate_patterns() {
    local timeout_s="$1"; shift
    local patterns=("$@")

    local pat
    for pat in "${patterns[@]}"; do
        if pgrep -f -- "$pat" >/dev/null 2>&1; then
            log "Sending SIGTERM to pattern: $pat"
            pkill -TERM -f -- "$pat" 2>/dev/null || true
        fi
    done

    local start now still_running
    start="$(date +%s)"
    while true; do
        still_running=0
        for pat in "${patterns[@]}"; do
            if pgrep -f -- "$pat" >/dev/null 2>&1; then
                still_running=1
                break
            fi
        done
        if [[ "$still_running" -eq 0 ]]; then
            return 0
        fi

        now="$(date +%s)"
        if (( now - start >= timeout_s )); then
            log "Timeout waiting for pattern '$pat' to exit. Skipping forced kill to preserve data."
            break
        fi
        sleep 1
    done
}

# Hyprland helper: run hyprctl even when shutdown environments don't carry HYPRLAND_INSTANCE_SIGNATURE.
hyprctl_cmd() {
    # Try the current environment first.
    if hyprctl "$@" 2>/dev/null; then
        return 0
    fi

    local uid runtime_dir
    uid="$(id -u)"
    runtime_dir="/run/user/${uid}"

    # Probe known Hyprland instance dirs.
    local sigdir sig
    for sigdir in "${runtime_dir}/hypr/"*; do
        [[ -d "$sigdir" ]] || continue
        sig="$(basename "$sigdir")"
        if HYPRLAND_INSTANCE_SIGNATURE="$sig" XDG_RUNTIME_DIR="$runtime_dir" hyprctl "$@" 2>/dev/null; then
            return 0
        fi
    done

    return 1
}

hypr_list_client_addrs() {
    hyprctl_cmd clients -j 2>/dev/null | python3 -c 'import sys, json
try:
    clients = json.load(sys.stdin)
except Exception:
    clients = []
for c in clients:
    addr = c.get("address")
    if addr:
        print(addr)
'
}

log "Starting shutdown script"

# Close all open applications gracefully
# Hyprland (Wayland): close all clients via hyprctl.
if command -v hyprctl &> /dev/null && command -v python3 &> /dev/null; then
    # hyprctl may fail in non-interactive shutdown environments; don't abort the script.
    if hyprctl_cmd clients -j >/dev/null 2>&1; then
        mapfile -t hypr_addrs < <(hypr_list_client_addrs || true)
        log "Hyprland: found ${#hypr_addrs[@]} window(s)"
        if ((${#hypr_addrs[@]} > 0)); then
            log "Hyprland: requesting graceful close of ${#hypr_addrs[@]} window(s)"
            for addr in "${hypr_addrs[@]}"; do
                hyprctl_cmd dispatch closewindow "address:${addr}" >/dev/null 2>&1 || true
            done

            # Give apps enough time to flush state (browsers can take a while).
            sleep 10
        fi
    else
        log "Hyprland: hyprctl clients -j unavailable (not in session or missing env)"
    fi
fi

# X11 (fallback / XWayland)
if command -v wmctrl &> /dev/null; then
    log "Closing window managed applications"
    wmctrl -l | awk '{print $1}' | while read -r window; do
        wmctrl -ic "$window" 2>/dev/null || true
    done
fi

# Terminate specific applications (gracefully first, then escalate).
# NOTE: Avoid deleting browser session/lock files here; let the apps shut down cleanly.
terminate_names 30 firefox
terminate_names 20 dolphin

# Browsers: match by command line because process names are often truncated (15-char comm limit).
terminate_patterns 30 '/usr/lib64/chromium-browser/chromium-browser' '(^|/)chromium( |$)'
terminate_patterns 30 '/opt/google/chrome/chrome' '(^|/)google-chrome( |$)'
terminate_patterns 30 '/opt/brave.com/brave/brave' '(^|/)brave( |$)' '/usr/bin/brave-browser'

# Terminals/editors
terminate_patterns 15 '/opt/warpdotdev/warp-terminal/warp' '(^|/)warp-terminal( |$)' '(^|/)warp( |$)'
terminate_names 10 terminator
terminate_names 10 sublime
terminate_names 10 code
terminate_names 10 java
