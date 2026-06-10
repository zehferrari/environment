#!/usr/bin/env bash
#
# install-pm-switch.sh — install/refresh the PM worktree switcher on a host.
# Idempotent; run as root. Stages the scripts, the monitor-run runner service,
# the one sudoers grant, the spool dir, and lets pm.service write the spool.
#
# Prerequisite: /srv/Code must be group-collaborative so the monitor can build —
# run `code-tree-perms` first (ai/openclaw/install.sh does this). See
# deploy/MULTI_AGENT_WORKTREES.md.
#
# Config via env:
#   PM_MONITOR_USER   (default: karen)   — runs the web app, runner, and switch
#   PM_SWITCH_DIR     (default: /var/lib/pm/switch)
#   PM_WORKTREES_ROOT (default: /srv/Code/environment.worktrees)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"          # ai/web/deploy
MON="${PM_MONITOR_USER:-karen}"
SWITCH_DIR="${PM_SWITCH_DIR:-/var/lib/pm/switch}"
WT_ROOT="${PM_WORKTREES_ROOT:-/srv/Code/environment.worktrees}"
SPOOL_DROPIN=/etc/systemd/system/pm.service.d/30-switch-spool.conf

die(){ printf 'install-pm-switch: %s\n' "$*" >&2; exit 1; }
say(){ printf '\n==> %s\n' "$*"; }

[[ $EUID -eq 0 ]] || die "run as root (sudo)"
id "$MON" >/dev/null 2>&1 || die "monitor user not found: $MON"
command -v visudo >/dev/null || die "visudo not found"

say "Install scripts → /usr/local/sbin"
install -o root -g root -m 0755 "$HERE/pm-apply-worktree" /usr/local/sbin/pm-apply-worktree
install -o root -g root -m 0755 "$HERE/pm-switch.sh"      /usr/local/sbin/pm-switch
install -o root -g root -m 0755 "$HERE/pm-switch-runner"  /usr/local/sbin/pm-switch-runner

say "Install rebuilding page → /var/www/pm-maintenance/rebuilding.html"
# Static maintenance page nginx serves (error_page 502/503/504) while pm.service
# is down mid-switch. Lives outside the build tree so a `next build` can't wipe
# it and nginx can always read it. Pair with the error_page block in
# nginx-agents.vixi.au.conf, then `nginx -t && systemctl reload nginx`.
install -d -o root -g root -m 0755 /var/www/pm-maintenance
install -o root -g root -m 0644 "$HERE/rebuilding.html" /var/www/pm-maintenance/rebuilding.html

say "Render runner unit (User=$MON) → /etc/systemd/system/pm-switch-runner.service"
sed "s/__PM_MONITOR_USER__/$MON/g; s#/srv/Code/environment.worktrees#$WT_ROOT#g; s#/var/lib/pm/switch#$SWITCH_DIR#g" \
  "$HERE/systemd/pm-switch-runner.service" > /etc/systemd/system/pm-switch-runner.service
chmod 0644 /etc/systemd/system/pm-switch-runner.service

say "Render + validate sudoers → /etc/sudoers.d/pm-switch"
TMP="$(mktemp)"
sed "s/__PM_MONITOR_USER__/$MON/g" "$HERE/sudoers.d/pm-switch" > "$TMP"
visudo -cf "$TMP" || { rm -f "$TMP"; die "sudoers validation failed"; }
install -o root -g root -m 0440 "$TMP" /etc/sudoers.d/pm-switch
rm -f "$TMP"

say "Spool dir $SWITCH_DIR (monitor-only 0700)"
install -d -o "$MON" -g "$MON" -m 0700 "$SWITCH_DIR"

say "Let pm.service write the spool (ReadWritePaths drop-in)"
install -d /etc/systemd/system/pm.service.d
NEW="$(printf '[Service]\nReadWritePaths=%s\n' "$SWITCH_DIR")"
spool_changed=0
[[ "$(cat "$SPOOL_DROPIN" 2>/dev/null || true)" != "$NEW" ]] && { printf '%s\n' "$NEW" > "$SPOOL_DROPIN"; chmod 0644 "$SPOOL_DROPIN"; spool_changed=1; }

say "Reload + (re)start units"
systemctl daemon-reload
systemctl enable --now pm-switch-runner.service
# Only bounce the live site if the sandbox actually changed.
if [[ "$spool_changed" == 1 ]]; then
  echo "  spool drop-in changed — restarting pm.service to pick it up"
  systemctl restart pm.service
fi

say "Done. runner=$(systemctl is-active pm-switch-runner.service)  pm=$(systemctl is-active pm.service)  monitor=$MON"
