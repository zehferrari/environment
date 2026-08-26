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
#   PM_MONITOR_HOME   (default: account home from passwd)
#   PM_MONITOR_GROUP  (default: monitor account's primary group)
#   PM_REPO_ROOT      (default: /srv/Code/environment)
#   PM_WORKTREES_ROOT (default: /srv/Code/environment.worktrees)
#   PM_CODE_GROUP     (default: code-agents)
#   PM_SWITCH_DIR     (default: /var/lib/pm/switch)
#   PM_LOCK_DIR / PM_WORKTREE_LOCK
#   PM_DB_DIR / PM_CANONICAL_DB
#   PM_PNPM_BIN / PM_SYSTEM_ENV_FILE / PM_ACTIVE_ENV_FILE / PM_DROP_DIR
set -euo pipefail

die(){ printf 'install-pm-switch: %s\n' "$*" >&2; exit 1; }
say(){ printf '\n==> %s\n' "$*"; }

load_deploy_contract() {
  local config=/etc/default/pm-deploy owner mode
  [[ -e "$config" ]] || return 0
  [[ -f "$config" && ! -L "$config" ]] || die "deployment contract is not a regular file: $config"
  owner="$(stat -c '%u' "$config")"
  mode="$(stat -c '%a' "$config")"
  [[ "$owner" == 0 && $((8#$mode & 8#022)) -eq 0 ]] \
    || die "deployment contract must be root-owned and not group/other-writable: $config"
  # shellcheck disable=SC1091 -- fixed, root-owned host contract.
  . "$config"
}

load_deploy_contract

HERE="$(cd "$(dirname "$0")" && pwd)"          # ai/web/deploy
MON="${PM_MONITOR_USER:-${PM_DEPLOY_MONITOR_USER:-karen}}"
MON_HOME="${PM_MONITOR_HOME:-${PM_DEPLOY_MONITOR_HOME:-}}"
MON_GROUP="${PM_MONITOR_GROUP:-${PM_DEPLOY_MONITOR_GROUP:-}}"
REPO_ROOT="${PM_REPO_ROOT:-${PM_DEPLOY_REPO_ROOT:-/srv/Code/environment}}"
SWITCH_DIR="${PM_SWITCH_DIR:-${PM_DEPLOY_SWITCH_DIR:-/var/lib/pm/switch}}"
WT_ROOT="${PM_WORKTREES_ROOT:-${PM_DEPLOY_WORKTREES_ROOT:-/srv/Code/environment.worktrees}}"
CODE_GROUP="${PM_CODE_GROUP:-${PM_DEPLOY_CODE_GROUP:-code-agents}}"
CONTRACT_LOCK="${PM_WORKTREE_LOCK:-${PM_DEPLOY_WORKTREE_LOCK:-}}"
LOCK_DIR="${PM_LOCK_DIR:-${CONTRACT_LOCK:+$(dirname "$CONTRACT_LOCK")}}"
LOCK_DIR="${LOCK_DIR:-/var/lib/worktree-locks}"
LOCK_FILE="${CONTRACT_LOCK:-$LOCK_DIR/environment.lock}"
DB_ROOT="${PM_DB_DIR:-${PM_DEPLOY_DB_ROOT:-/srv/Data/pm}}"
CANONICAL_DB="${PM_CANONICAL_DB:-${PM_DEPLOY_CANONICAL_DB:-$DB_ROOT/pm.db}}"
RECEIPT_DIR="${PM_DEPLOY_RECEIPT_DIR:-$DB_ROOT/deployment-receipts}"
PNPM_BIN="${PM_PNPM_BIN:-${PM_DEPLOY_PNPM_BIN:-/usr/local/bin/pnpm}}"
SYSTEM_ENV_FILE="${PM_SYSTEM_ENV_FILE:-${PM_DEPLOY_SYSTEM_ENV_FILE:-/etc/default/pm}}"
ACTIVE_ENV_FILE="${PM_ACTIVE_ENV_FILE:-${PM_DEPLOY_ACTIVE_ENV_FILE:-/etc/default/pm-active-worktree}}"
DROP_DIR="${PM_DROP_DIR:-${PM_DEPLOY_DROP_DIR:-/var/lib/pm/drop}}"
DEPLOY_CONFIG=/etc/default/pm-deploy
SPOOL_DROPIN=/etc/systemd/system/pm.service.d/30-switch-spool.conf
MAINTENANCE_FILE="$SWITCH_DIR/.maintenance"

[[ $EUID -eq 0 ]] || die "run as root (sudo)"
id "$MON" >/dev/null 2>&1 || die "monitor user not found: $MON"
getent group "$CODE_GROUP" >/dev/null || die "code group not found: $CODE_GROUP"
command -v visudo >/dev/null || die "visudo not found"
command -v runuser >/dev/null || die "runuser not found"
[[ "$MON" =~ ^[a-zA-Z0-9_.-]+$ ]] || die "invalid monitor user: $MON"
[[ "$CODE_GROUP" =~ ^[a-zA-Z0-9_.-]+$ ]] || die "invalid code group: $CODE_GROUP"
if [[ -z "$MON_HOME" ]]; then
  MON_HOME="$(getent passwd "$MON" | cut -d: -f6)"
fi
if [[ -z "$MON_GROUP" ]]; then
  MON_GROUP="$(id -gn "$MON")"
fi
getent group "$MON_GROUP" >/dev/null || die "monitor group not found: $MON_GROUP"
[[ "$MON_GROUP" =~ ^[a-zA-Z0-9_.-]+$ ]] || die "invalid monitor group: $MON_GROUP"

validate_path() {
  local label="$1" value="$2"
  [[ "$value" =~ ^/[-a-zA-Z0-9_./:@%+=,]+$ ]] \
    || die "$label must be an absolute path containing only portable path characters: $value"
}

validate_path PM_MONITOR_HOME "$MON_HOME"
validate_path PM_REPO_ROOT "$REPO_ROOT"
validate_path PM_WORKTREES_ROOT "$WT_ROOT"
validate_path PM_SWITCH_DIR "$SWITCH_DIR"
validate_path PM_LOCK_DIR "$LOCK_DIR"
validate_path PM_WORKTREE_LOCK "$LOCK_FILE"
validate_path PM_DB_DIR "$DB_ROOT"
validate_path PM_CANONICAL_DB "$CANONICAL_DB"
validate_path PM_DEPLOY_RECEIPT_DIR "$RECEIPT_DIR"
validate_path PM_PNPM_BIN "$PNPM_BIN"
validate_path PM_SYSTEM_ENV_FILE "$SYSTEM_ENV_FILE"
validate_path PM_ACTIVE_ENV_FILE "$ACTIVE_ENV_FILE"
validate_path PM_DROP_DIR "$DROP_DIR"

[[ -d "$REPO_ROOT" ]] || die "repository root does not exist: $REPO_ROOT"
[[ -d "$WT_ROOT" ]] || die "worktree root does not exist: $WT_ROOT"
if ! runuser -u "$MON" -- test -r "$REPO_ROOT" \
  || ! runuser -u "$MON" -- test -x "$REPO_ROOT" \
  || ! runuser -u "$MON" -- test -r "$WT_ROOT" \
  || ! runuser -u "$MON" -- test -w "$WT_ROOT" \
  || ! runuser -u "$MON" -- test -x "$WT_ROOT"; then
  die "monitor user $MON cannot traverse the repository or write the worktree root; run code-tree-perms --tree $(dirname "$REPO_ROOT") --group $CODE_GROUP --monitor $MON, then retry"
fi

# Quiesce the browser runner before replacing any helper. The operation lock
# lets an in-flight switch/removal finish; the marker keeps queued requests in
# request.json until the refreshed runner is ready. Preserve the lock inode so
# every process continues to serialize on the same file.
install -d -o "$MON" -g "$MON_GROUP" -m 0700 "$SWITCH_DIR"
install -d -o "$MON" -g "$CODE_GROUP" -m 2770 "$RECEIPT_DIR"
install -d -o root -g "$CODE_GROUP" -m 0750 "$LOCK_DIR"
if [[ -e "$LOCK_FILE" ]]; then
  [[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" ]] || die "operation lock is not a regular file: $LOCK_FILE"
  chown root:"$CODE_GROUP" "$LOCK_FILE"
  chmod 0660 "$LOCK_FILE"
else
  install -o root -g "$CODE_GROUP" -m 0660 /dev/null "$LOCK_FILE"
fi

maintenance_owned=0
if mkdir "$MAINTENANCE_FILE" 2>/dev/null; then
  chown root:root "$MAINTENANCE_FILE"
  chmod 0755 "$MAINTENANCE_FILE"
  maintenance_owned=1
elif [[ "${PM_OPERATION_LOCK_HELD:-0}" == 1 && -d "$MAINTENANCE_FILE" && ! -L "$MAINTENANCE_FILE" ]]; then
  # update-managed-host owns the atomic marker and the already-held lock.
  maintenance_owned=0
else
  die "another PM deployment/install is already in progress: $MAINTENANCE_FILE"
fi

runner_was_active="$(systemctl is-active pm-switch-runner.service 2>/dev/null || true)"
pm_was_active="$(systemctl is-active pm.service 2>/dev/null || true)"

cleanup() {
  local rc=$?
  trap - EXIT
  if [[ "$maintenance_owned" == 1 ]]; then
    rmdir "$MAINTENANCE_FILE" 2>/dev/null || true
  fi
  if [[ "$rc" -ne 0 && "$runner_was_active" == active ]]; then
    systemctl start pm-switch-runner.service >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT

if [[ "${PM_OPERATION_LOCK_HELD:-0}" != 1 ]]; then
  exec 9<>"$LOCK_FILE"
  flock -x 9
fi
if [[ "$runner_was_active" == active ]]; then
  systemctl stop pm-switch-runner.service
fi

say "Write non-secret host deployment contract -> $DEPLOY_CONFIG"
tmp_config="$(mktemp)"
{
  printf '# Managed by ai/web/deploy/install-pm-switch.sh; contains no secrets.\n'
  printf 'PM_DEPLOY_MONITOR_USER=%s\n' "$MON"
  printf 'PM_DEPLOY_MONITOR_HOME=%s\n' "$MON_HOME"
  printf 'PM_DEPLOY_MONITOR_GROUP=%s\n' "$MON_GROUP"
  printf 'PM_DEPLOY_CODE_GROUP=%s\n' "$CODE_GROUP"
  printf 'PM_DEPLOY_REPO_ROOT=%s\n' "$REPO_ROOT"
  printf 'PM_DEPLOY_WORKTREES_ROOT=%s\n' "$WT_ROOT"
  printf 'PM_DEPLOY_SWITCH_DIR=%s\n' "$SWITCH_DIR"
  printf 'PM_DEPLOY_WORKTREE_LOCK=%s\n' "$LOCK_FILE"
  printf 'PM_DEPLOY_DB_ROOT=%s\n' "$DB_ROOT"
  printf 'PM_DEPLOY_CANONICAL_DB=%s\n' "$CANONICAL_DB"
  printf 'PM_DEPLOY_RECEIPT_DIR=%s\n' "$RECEIPT_DIR"
  printf 'PM_DEPLOY_PNPM_BIN=%s\n' "$PNPM_BIN"
  printf 'PM_DEPLOY_SYSTEM_ENV_FILE=%s\n' "$SYSTEM_ENV_FILE"
  printf 'PM_DEPLOY_ACTIVE_ENV_FILE=%s\n' "$ACTIVE_ENV_FILE"
  printf 'PM_DEPLOY_DROP_DIR=%s\n' "$DROP_DIR"
} > "$tmp_config"
install -o root -g root -m 0644 "$tmp_config" "$DEPLOY_CONFIG"
rm -f "$tmp_config"

say "Install scripts → /usr/local/sbin"
install -o root -g root -m 0755 "$HERE/pm-apply-worktree" /usr/local/sbin/pm-apply-worktree
install -o root -g root -m 0755 "$HERE/pm-switch.sh"      /usr/local/sbin/pm-switch
install -o root -g root -m 0755 "$HERE/pm-switch-runner"  /usr/local/sbin/pm-switch-runner
install -o root -g root -m 0755 "$HERE/worktree-remove"   /usr/local/sbin/worktree-remove

say "Install rebuilding page → /var/www/pm-maintenance/rebuilding.html"
# Static maintenance page nginx serves (error_page 502/503/504) while pm.service
# is down mid-switch. Lives outside the build tree so a `next build` can't wipe
# it and nginx can always read it. Pair with the error_page block in
# nginx-mission-control.conf, then `nginx -t && systemctl reload nginx`.
install -d -o root -g root -m 0755 /var/www/pm-maintenance
install -o root -g root -m 0644 "$HERE/rebuilding.html" /var/www/pm-maintenance/rebuilding.html

say "Render runner unit (User=$MON) → /etc/systemd/system/pm-switch-runner.service"
sed "s#__PM_MONITOR_USER__#$MON#g; s#__PM_MONITOR_HOME__#$MON_HOME#g; s#__PM_CODE_GROUP__#$CODE_GROUP#g; s#__PM_REPO_ROOT__#$REPO_ROOT#g; s#__PM_WORKTREES_ROOT__#$WT_ROOT#g; s#__PM_SWITCH_DIR__#$SWITCH_DIR#g; s#__PM_LOCK_FILE__#$LOCK_FILE#g" \
  "$HERE/systemd/pm-switch-runner.service" > /etc/systemd/system/pm-switch-runner.service
chmod 0644 /etc/systemd/system/pm-switch-runner.service

say "Render + validate sudoers → /etc/sudoers.d/pm-switch"
TMP="$(mktemp)"
sed "s/__PM_MONITOR_USER__/$MON/g" "$HERE/sudoers.d/pm-switch" > "$TMP"
visudo -cf "$TMP" || { rm -f "$TMP"; die "sudoers validation failed"; }
install -o root -g root -m 0440 "$TMP" /etc/sudoers.d/pm-switch
rm -f "$TMP"

say "Let pm.service write the spool (ReadWritePaths drop-in)"
install -d /etc/systemd/system/pm.service.d
NEW="$(printf '[Service]\nReadWritePaths=%s\n' "$SWITCH_DIR")"
spool_changed=0
[[ "$(cat "$SPOOL_DROPIN" 2>/dev/null || true)" != "$NEW" ]] && { printf '%s\n' "$NEW" > "$SPOOL_DROPIN"; chmod 0644 "$SPOOL_DROPIN"; spool_changed=1; }

say "Reload + (re)start units"
systemctl daemon-reload
systemctl enable pm-switch-runner.service
# The runner is a long-lived Python process, so restart it to load the newly
# installed helper. It remains paused when a parent host update owns the marker.
systemctl restart pm-switch-runner.service
# Only bounce a site that was already running. A first install has no build yet;
# its initial pm-switch below is responsible for starting both PM services.
if [[ "$spool_changed" == 1 && "$pm_was_active" == active ]]; then
  echo "  spool drop-in changed — restarting pm.service to pick it up"
  systemctl restart pm.service
fi

if [[ "$maintenance_owned" == 1 ]]; then
  rmdir "$MAINTENANCE_FILE"
  maintenance_owned=0
fi
trap - EXIT

say "Done. runner=$(systemctl is-active pm-switch-runner.service)  pm=$(systemctl is-active pm.service)  monitor=$MON"
