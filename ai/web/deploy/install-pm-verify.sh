#!/usr/bin/env bash
#
# install-pm-verify.sh — install/refresh the PM branch-verify runner and the
# PM epic-merge runner on a host. Idempotent; run as root. Mirrors
# install-pm-switch.sh but is simpler — neither runner has a privileged step,
# so there is no sudoers grant to install.
#
# Prereqs:
#   - /srv/Code is group-collaborative (run code-tree-perms first).
#   - pm.service is installed; /etc/default/pm exists with DATABASE_URL.
#   - pm-switch is already installed (the runners reuse
#     /etc/default/pm-active-worktree and read pm.service's WorkingDirectory
#     to locate the active worktree).
#
# Config via env:
#   PM_MONITOR_USER         PM app user that authors verifier/merge comments (default: monitor)
#   PM_VERIFY_RUN_USER      OS user that runs git fetch; needs repo read credentials (default: PM_MONITOR_USER)
#   PM_MERGE_RUN_USER       OS user that pushes the Epic branch; needs repo WRITE credentials (default: PM_VERIFY_RUN_USER)
#   PM_SHARED_GROUP         group shared by pm.service + runner users (default: code-agents)
#   PM_BRANCH_VERIFY_DIR    verify spool dir (default: /var/lib/pm/branch-verify)
#   PM_EPIC_MERGE_DIR       epic-merge spool dir (default: /var/lib/pm/epic-merge)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"         # ai/web/deploy
MON="${PM_MONITOR_USER:-monitor}"
RUN="${PM_VERIFY_RUN_USER:-$MON}"
MERGE_RUN="${PM_MERGE_RUN_USER:-$RUN}"
SHARED_GROUP="${PM_SHARED_GROUP:-code-agents}"
VERIFY_DIR="${PM_BRANCH_VERIFY_DIR:-/var/lib/pm/branch-verify}"
MERGE_DIR="${PM_EPIC_MERGE_DIR:-/var/lib/pm/epic-merge}"
SPOOL_DROPIN=/etc/systemd/system/pm.service.d/40-branch-verify-spool.conf
MERGE_SPOOL_DROPIN=/etc/systemd/system/pm.service.d/41-epic-merge-spool.conf

die(){ printf 'install-pm-verify: %s\n' "$*" >&2; exit 1; }
say(){ printf '\n==> %s\n' "$*"; }

[[ $EUID -eq 0 ]] || die "run as root (sudo)"
id "$MON" >/dev/null 2>&1 || die "monitor user not found: $MON"
id "$RUN" >/dev/null 2>&1 || die "verify run user not found: $RUN"
id "$MERGE_RUN" >/dev/null 2>&1 || die "merge run user not found: $MERGE_RUN"
getent group "$SHARED_GROUP" >/dev/null 2>&1 || die "shared group not found: $SHARED_GROUP"

say "Install runners → /usr/local/sbin/pm-verify-runner, /usr/local/sbin/pm-epic-merge-runner"
install -o root -g root -m 0755 "$HERE/pm-verify-runner" /usr/local/sbin/pm-verify-runner
install -o root -g root -m 0755 "$HERE/pm-epic-merge-runner" /usr/local/sbin/pm-epic-merge-runner

say "Render verify runner unit (User=$RUN, monitor=$MON) → /etc/systemd/system/pm-verify-runner.service"
sed "s/__PM_MONITOR_USER__/$MON/g; s/__PM_VERIFY_RUN_USER__/$RUN/g; s#/var/lib/pm/branch-verify#$VERIFY_DIR#g" \
  "$HERE/systemd/pm-verify-runner.service" > /etc/systemd/system/pm-verify-runner.service
chmod 0644 /etc/systemd/system/pm-verify-runner.service

say "Render epic-merge runner unit (User=$MERGE_RUN, monitor=$MON) → /etc/systemd/system/pm-epic-merge-runner.service"
sed "s/__PM_MONITOR_USER__/$MON/g; s/__PM_MERGE_RUN_USER__/$MERGE_RUN/g; s#/var/lib/pm/epic-merge#$MERGE_DIR#g" \
  "$HERE/systemd/pm-epic-merge-runner.service" > /etc/systemd/system/pm-epic-merge-runner.service
chmod 0644 /etc/systemd/system/pm-epic-merge-runner.service

say "Spool dirs $VERIFY_DIR + $MERGE_DIR (group-shared 2770, group=$SHARED_GROUP)"
install -d -o "$MON" -g "$SHARED_GROUP" -m 2770 "$VERIFY_DIR"
chmod g+s "$VERIFY_DIR"
install -d -o "$MON" -g "$SHARED_GROUP" -m 2770 "$MERGE_DIR"
chmod g+s "$MERGE_DIR"

say "Let pm.service write the spools (ReadWritePaths drop-ins)"
install -d /etc/systemd/system/pm.service.d
NEW="$(printf '[Service]\nReadWritePaths=%s\n' "$VERIFY_DIR")"
spool_changed=0
[[ "$(cat "$SPOOL_DROPIN" 2>/dev/null || true)" != "$NEW" ]] && {
  printf '%s\n' "$NEW" > "$SPOOL_DROPIN"
  chmod 0644 "$SPOOL_DROPIN"
  spool_changed=1
}
NEW_MERGE="$(printf '[Service]\nReadWritePaths=%s\n' "$MERGE_DIR")"
[[ "$(cat "$MERGE_SPOOL_DROPIN" 2>/dev/null || true)" != "$NEW_MERGE" ]] && {
  printf '%s\n' "$NEW_MERGE" > "$MERGE_SPOOL_DROPIN"
  chmod 0644 "$MERGE_SPOOL_DROPIN"
  spool_changed=1
}

say "Reload + (re)start units"
systemctl daemon-reload
systemctl enable pm-verify-runner.service pm-epic-merge-runner.service
systemctl restart pm-verify-runner.service pm-epic-merge-runner.service
if [[ "$spool_changed" == 1 ]]; then
  echo "  spool drop-in changed — restarting pm.service to pick it up"
  systemctl restart pm.service
fi

say "Done. verify=$(systemctl is-active pm-verify-runner.service)  merge=$(systemctl is-active pm-epic-merge-runner.service)  monitor=$MON  verify_user=$RUN  merge_user=$MERGE_RUN"
