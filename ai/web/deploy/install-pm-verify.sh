#!/usr/bin/env bash
#
# install-pm-verify.sh — install/refresh the PM branch-verify runner on a host.
# Idempotent; run as root. Mirrors install-pm-switch.sh but is simpler — the
# verifier has no privileged step, so there is no sudoers grant to install.
#
# Prereqs:
#   - /srv/Code is group-collaborative (run code-tree-perms first).
#   - pm.service is installed; /etc/default/pm exists with DATABASE_URL.
#   - pm-switch is already installed (the verifier reuses /etc/default/pm and
#     reads pm.service's WorkingDirectory to locate the active worktree).
#
# Config via env:
#   PM_MONITOR_USER        (default: karen)
#   PM_BRANCH_VERIFY_DIR   (default: /var/lib/pm/branch-verify)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"         # ai/web/deploy
MON="${PM_MONITOR_USER:-karen}"
VERIFY_DIR="${PM_BRANCH_VERIFY_DIR:-/var/lib/pm/branch-verify}"
SPOOL_DROPIN=/etc/systemd/system/pm.service.d/40-branch-verify-spool.conf

die(){ printf 'install-pm-verify: %s\n' "$*" >&2; exit 1; }
say(){ printf '\n==> %s\n' "$*"; }

[[ $EUID -eq 0 ]] || die "run as root (sudo)"
id "$MON" >/dev/null 2>&1 || die "monitor user not found: $MON"

say "Install runner → /usr/local/sbin/pm-verify-runner"
install -o root -g root -m 0755 "$HERE/pm-verify-runner" /usr/local/sbin/pm-verify-runner

say "Render runner unit (User=$MON) → /etc/systemd/system/pm-verify-runner.service"
sed "s/__PM_MONITOR_USER__/$MON/g; s#/var/lib/pm/branch-verify#$VERIFY_DIR#g" \
  "$HERE/systemd/pm-verify-runner.service" > /etc/systemd/system/pm-verify-runner.service
chmod 0644 /etc/systemd/system/pm-verify-runner.service

say "Spool dir $VERIFY_DIR (monitor-only 0700)"
install -d -o "$MON" -g "$MON" -m 0700 "$VERIFY_DIR"

say "Let pm.service write the spool (ReadWritePaths drop-in)"
install -d /etc/systemd/system/pm.service.d
NEW="$(printf '[Service]\nReadWritePaths=%s\n' "$VERIFY_DIR")"
spool_changed=0
[[ "$(cat "$SPOOL_DROPIN" 2>/dev/null || true)" != "$NEW" ]] && {
  printf '%s\n' "$NEW" > "$SPOOL_DROPIN"
  chmod 0644 "$SPOOL_DROPIN"
  spool_changed=1
}

say "Reload + (re)start units"
systemctl daemon-reload
systemctl enable --now pm-verify-runner.service
if [[ "$spool_changed" == 1 ]]; then
  echo "  spool drop-in changed — restarting pm.service to pick it up"
  systemctl restart pm.service
fi

say "Done. runner=$(systemctl is-active pm-verify-runner.service)  monitor=$MON"
