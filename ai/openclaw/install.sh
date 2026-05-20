#!/bin/bash
# install.sh — deploy OpenClaw host-level scripts + systemd units.
#
# Idempotent: re-running with no source changes is a no-op modulo a few
# stat/md5 checks. Designed to be run after every `git pull` in this
# repo working tree, or on a fresh host as part of bootstrap.
#
# What it does:
#   1. install bin/ scripts to /usr/local/bin and /usr/local/sbin
#      (preserving the same /usr/local/{bin,sbin} split openclaw uses today)
#   2. install systemd unit files to /etc/systemd/system
#   3. generate openclaw-monitor-sync.path from agents.json (host-specific:
#      systemd Path units don't support globs, so the file enumerates
#      one PathChanged= line per enabled agent's monitor.json)
#   4. symlink the frontend HTML for agent-dashboard
#   5. systemctl daemon-reload + enable+restart what's running
#
# What it does NOT do:
#   - install sudoers files (must be reviewed + substituted by hand)
#   - install /etc/agent-dashboard/config.json (host-specific, copy
#     config/agent-dashboard.config.json.example as a starting point)
#   - install /etc/openclaw/agents.json (host-specific identity file)
#
# Run as root:  sudo ./install.sh
# Dry run:      ./install.sh --dry-run

set -u
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="${OPENCLAW_AGENTS_JSON:-/etc/openclaw/agents.json}"

# Color/log helpers — short, terminal-aware.
if [ -t 1 ]; then
    C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_DIM=$'\e[2m'; C_RST=$'\e[0m'
else
    C_OK=''; C_WARN=''; C_DIM=''; C_RST=''
fi
log() { printf '%s%s%s\n' "${C_DIM}" "$*" "${C_RST}"; }
ok()  { printf '%s✓%s %s\n' "${C_OK}" "${C_RST}" "$*"; }
warn(){ printf '%s!%s %s\n' "${C_WARN}" "${C_RST}" "$*"; }

if [ "$EUID" -ne 0 ] && [ "$DRY" -eq 0 ]; then
    warn "must run as root (use --dry-run to preview)"
    exit 1
fi

do_install() {
    local mode="$1" src="$2" dst="$3"
    if [ ! -e "$src" ]; then
        warn "missing source $src — skipping"
        return
    fi
    if [ "$DRY" -eq 1 ]; then
        log "  would install -m $mode $src → $dst"
        return
    fi
    install -o root -g root -m "$mode" "$src" "$dst"
    ok "$dst"
}

# 1. bin scripts — /usr/local/bin for what gets called by agent code/users,
#                  /usr/local/sbin for what's only called by systemd or root.
log "[1/5] bin scripts"
do_install 755 "$REPO_ROOT/bin/ai-monitor"                /usr/local/bin/ai-monitor
do_install 755 "$REPO_ROOT/bin/openclaw-integrity-check"  /usr/local/bin/openclaw-integrity-check
do_install 755 "$REPO_ROOT/bin/openclaw-control"          /usr/local/sbin/openclaw-control
do_install 755 "$REPO_ROOT/bin/agent-dashboard"           /usr/local/bin/agent-dashboard
do_install 755 "$REPO_ROOT/bin/openclaw-monitor-sync"     /usr/local/sbin/openclaw-monitor-sync
do_install 755 "$REPO_ROOT/bin/openclaw-typing-keepalive" /usr/local/bin/openclaw-typing-keepalive
do_install 755 "$REPO_ROOT/bin/gmail-watch-renew-all"     /usr/local/sbin/gmail-watch-renew-all

# 2. systemd units (universal — host-portable as written)
log "[2/5] systemd units"
for u in agent-dashboard.service \
         openclaw-monitor-sync.service openclaw-monitor-sync.timer \
         openclaw-typing-keepalive.service \
         gmail-watch-renew.service gmail-watch-renew.timer; do
    do_install 644 "$REPO_ROOT/systemd/$u" "/etc/systemd/system/$u"
done

# 3. generate openclaw-monitor-sync.path (host-specific — enumerates per-agent monitor.json)
log "[3/5] generate openclaw-monitor-sync.path from $REGISTRY"
if [ ! -r "$REGISTRY" ]; then
    warn "  $REGISTRY not readable; skipping .path generation"
else
    PATH_LINES=""
    while IFS=$'\t' read -r user home; do
        [ -z "$user" ] && continue
        mpath="${home:-/home/$user}/.local/openclaw/monitor.json"
        PATH_LINES+=$'PathChanged='"$mpath"$'\n'
    done < <(jq -r '.agents[] | select(.enabled == true) | "\(.user)\t\(.home // "")"' "$REGISTRY")

    TMP=$(mktemp)
    awk -v lines="$PATH_LINES" '/@PATH_CHANGED_LINES@/{printf "%s", lines; next} {print}' \
        "$REPO_ROOT/systemd/openclaw-monitor-sync.path.in" > "$TMP"
    if [ "$DRY" -eq 1 ]; then
        log "  would install $TMP → /etc/systemd/system/openclaw-monitor-sync.path"
        log "  generated PathChanged lines:"
        printf '%s' "$PATH_LINES" | sed 's/^/    /'
    else
        install -o root -g root -m 644 "$TMP" /etc/systemd/system/openclaw-monitor-sync.path
        ok "/etc/systemd/system/openclaw-monitor-sync.path"
    fi
    rm -f "$TMP"
fi

# 4. dashboard frontend symlink
log "[4/5] dashboard frontend symlink"
WEB_HTML="$REPO_ROOT/../web/agents.html"
WEB_HTML="$(cd "$(dirname "$WEB_HTML")" && pwd)/$(basename "$WEB_HTML")"
if [ -f "$WEB_HTML" ]; then
    if [ "$DRY" -eq 1 ]; then
        log "  would symlink /usr/local/share/agent-dashboard/agents.html → $WEB_HTML"
    else
        mkdir -p /usr/local/share/agent-dashboard
        ln -snf "$WEB_HTML" /usr/local/share/agent-dashboard/agents.html
        ok "/usr/local/share/agent-dashboard/agents.html → $WEB_HTML"
    fi
else
    warn "  frontend $WEB_HTML not found; skipping symlink"
fi

# 5. reload + restart what's running
log "[5/5] systemctl daemon-reload + restart running units"
if [ "$DRY" -eq 1 ]; then
    log "  would: systemctl daemon-reload"
    log "  would: restart any units currently active"
else
    systemctl daemon-reload
    ok "systemctl daemon-reload"
    # Restart units that were already active (preserves user's enable/disable choices).
    for u in agent-dashboard.service \
             openclaw-typing-keepalive.service \
             openclaw-monitor-sync.path \
             openclaw-monitor-sync.timer \
             gmail-watch-renew.timer; do
        if systemctl is-enabled --quiet "$u" 2>/dev/null; then
            systemctl restart "$u" || warn "  restart $u failed (continuing)"
        fi
    done
    ok "running units restarted"
fi

echo
log "Done. To enable a unit for the first time:"
log "  sudo systemctl enable --now agent-dashboard.service"
log "  sudo systemctl enable --now openclaw-monitor-sync.path openclaw-monitor-sync.timer"
log "  sudo systemctl enable --now openclaw-typing-keepalive.service   # claude-cli hosts only"
log "  sudo systemctl enable --now gmail-watch-renew.timer            # gmail-integrated hosts only"
