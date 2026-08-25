#!/usr/bin/env bash
#
# Fast-forward one clean managed worktree to its remote branch, refresh the
# repository-owned deployment helpers, apply every committed Prisma migration,
# build, restart pm.service + pm-consumer.service, and verify the live app.
#
# Run as root so the script can refresh root-owned helpers while deliberately
# running git/pnpm as the repository owner and the build/switch as the monitor.
# No secrets are read into output and no database/build artefacts enter git.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: update-managed-host.sh --worktree <path> [options]

Options:
  --repo-user <user>       Git checkout owner (default: worktree owner)
  --monitor-user <user>    PM switch/build user (default: pm-switch runner user
                           or PM_DEPLOY_MONITOR_USER)
  --branch <branch>        Expected checked-out branch (default: current branch)
  --remote <name>          Git remote to fetch (default: origin)
  --skip-install           Do not run pnpm install --frozen-lockfile
  -h, --help               Show this help

The worktree must be clean and its local HEAD must be an ancestor of the
remote branch. Local-ahead and diverged branches are refused; this script never
commits, rebases, resets, force-pushes, or deletes work.
EOF
}

die() { printf 'update-managed-host: %s\n' "$*" >&2; exit 1; }
say() { printf '\n==> %s\n' "$*"; }

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

WORKTREE=""
REPO_USER=""
MONITOR_USER=""
EXPECTED_BRANCH=""
REMOTE=origin
INSTALL_DEPS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --worktree) WORKTREE="${2:-}"; shift 2 ;;
    --repo-user) REPO_USER="${2:-}"; shift 2 ;;
    --monitor-user) MONITOR_USER="${2:-}"; shift 2 ;;
    --branch) EXPECTED_BRANCH="${2:-}"; shift 2 ;;
    --remote) REMOTE="${2:-}"; shift 2 ;;
    --skip-install) INSTALL_DEPS=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run as root (sudo)"
[[ -n "$WORKTREE" ]] || { usage >&2; exit 2; }
[[ "$REMOTE" =~ ^[a-zA-Z0-9._-]+$ && "$REMOTE" != -* ]] || die "invalid remote name: $REMOTE"

load_deploy_contract

WORKTREE="$(readlink -f "$WORKTREE" 2>/dev/null || true)"
[[ -n "$WORKTREE" && -d "$WORKTREE/ai/web" ]] || die "not an environment worktree: $WORKTREE"
APP_DIR="$WORKTREE/ai/web"
INSTALLER="$APP_DIR/deploy/install-pm-switch.sh"
[[ -x "$INSTALLER" ]] || die "switch installer is missing or not executable: $INSTALLER"

if [[ -z "$REPO_USER" ]]; then
  REPO_USER="$(stat -c '%U' "$WORKTREE")"
fi
[[ "$REPO_USER" =~ ^[a-zA-Z0-9_.-]+$ ]] || die "invalid repository user: $REPO_USER"
id "$REPO_USER" >/dev/null 2>&1 || die "repository user does not exist: $REPO_USER"

run_repo() { sudo -n -H -u "$REPO_USER" -- "$@"; }

current_branch="$(run_repo git -C "$WORKTREE" branch --show-current)"
[[ -n "$current_branch" ]] || die "detached HEAD is not deployable: $WORKTREE"
if [[ -n "$EXPECTED_BRANCH" && "$current_branch" != "$EXPECTED_BRANCH" ]]; then
  die "worktree branch is $current_branch, expected $EXPECTED_BRANCH"
fi
BRANCH="${EXPECTED_BRANCH:-$current_branch}"
run_repo git check-ref-format "refs/heads/$BRANCH" >/dev/null \
  || die "invalid branch name: $BRANCH"

if [[ -z "$MONITOR_USER" ]]; then
  MONITOR_USER="$(systemctl show -p User --value pm-switch-runner.service 2>/dev/null || true)"
  MONITOR_USER="${MONITOR_USER:-${PM_DEPLOY_MONITOR_USER:-}}"
fi
[[ "$MONITOR_USER" =~ ^[a-zA-Z0-9_.-]+$ ]] || die "set --monitor-user to the PM switch runner account"
id "$MONITOR_USER" >/dev/null 2>&1 || die "monitor user does not exist: $MONITOR_USER"

switch_dir="${PM_SWITCH_DIR:-${PM_DEPLOY_SWITCH_DIR:-/var/lib/pm/switch}}"
operation_lock="${PM_WORKTREE_LOCK:-${PM_DEPLOY_WORKTREE_LOCK:-/var/lib/worktree-locks/environment.lock}}"
maintenance_file="$switch_dir/.maintenance"
[[ -d "$switch_dir" ]] || die "switch spool is missing; run install-pm-switch.sh first: $switch_dir"
[[ -f "$operation_lock" && ! -L "$operation_lock" ]] \
  || die "operation lock is missing; run install-pm-switch.sh first: $operation_lock"
mkdir "$maintenance_file" 2>/dev/null \
  || die "another PM deployment/install is already in progress: $maintenance_file"
chown root:root "$maintenance_file"
chmod 0755 "$maintenance_file"
maintenance_owned=1
operation_lock_held=0
runner_was_active="$(systemctl is-active pm-switch-runner.service 2>/dev/null || true)"

cleanup() {
  local rc=$?
  trap - EXIT
  if [[ "$operation_lock_held" == 1 ]]; then
    flock -u 9 || true
    exec 9>&-
  fi
  if [[ "$maintenance_owned" == 1 ]]; then
    rmdir "$maintenance_file" 2>/dev/null || true
  fi
  if [[ "$runner_was_active" == active ]] \
    && ! systemctl is-active --quiet pm-switch-runner.service 2>/dev/null; then
    systemctl start pm-switch-runner.service >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT

# Wait for any current UI/CLI operation, then stop request consumption before
# touching Git or node_modules. The installed runner observes the maintenance
# marker; stopping also safely covers the first upgrade from older runners.
exec 9<>"$operation_lock"
flock -x 9
operation_lock_held=1
if [[ "$runner_was_active" == active ]]; then
  systemctl stop pm-switch-runner.service
fi

status="$(run_repo git -C "$WORKTREE" status --porcelain=v1 --untracked-files=all)"
if [[ -n "$status" ]]; then
  printf '%s\n' "$status" >&2
  die "worktree has local changes; commit/stash them before deployment"
fi

run_repo git -C "$WORKTREE" remote get-url "$REMOTE" >/dev/null \
  || die "remote does not exist: $REMOTE"

say "Fetching $REMOTE/$BRANCH as $REPO_USER"
remote_ref="refs/remotes/$REMOTE/$BRANCH"
run_repo git -C "$WORKTREE" fetch --prune "$REMOTE" \
  "refs/heads/$BRANCH:$remote_ref"
run_repo git -C "$WORKTREE" rev-parse --verify "$remote_ref^{commit}" >/dev/null \
  || die "remote branch was not fetched: $REMOTE/$BRANCH"
if ! run_repo git -C "$WORKTREE" merge-base --is-ancestor HEAD "$remote_ref"; then
  die "local HEAD is ahead of or diverged from $REMOTE/$BRANCH; refusing to rewrite it"
fi

say "Fast-forwarding $WORKTREE to $REMOTE/$BRANCH"
run_repo git -C "$WORKTREE" merge --ff-only "$remote_ref"

PNPM_BIN="${PM_PNPM_BIN:-${PM_DEPLOY_PNPM_BIN:-/usr/local/bin/pnpm}}"
[[ -x "$PNPM_BIN" ]] || die "pnpm is not executable at $PNPM_BIN (set PM_PNPM_BIN)"
if [[ "$INSTALL_DEPS" == 1 ]]; then
  say "Installing the pinned dependency graph as $REPO_USER"
  run_repo "$PNPM_BIN" --dir "$APP_DIR" install --frozen-lockfile
fi

common_dir="$(run_repo git -C "$WORKTREE" rev-parse --path-format=absolute --git-common-dir)"
common_dir="$(readlink -f "$common_dir" 2>/dev/null || true)"
[[ -n "$common_dir" && "$(basename "$common_dir")" == .git ]] \
  || die "could not resolve the primary non-bare repository checkout"
primary_repo="${common_dir%/.git}"
worktrees_root="${PM_WORKTREES_ROOT:-${PM_DEPLOY_WORKTREES_ROOT:-$(dirname "$WORKTREE")}}"
code_group="${PM_CODE_GROUP:-${PM_DEPLOY_CODE_GROUP:-code-agents}}"

say "Refreshing the root-owned PM switcher and host deployment contract"
PM_MONITOR_USER="$MONITOR_USER" \
PM_REPO_ROOT="${PM_REPO_ROOT:-${PM_DEPLOY_REPO_ROOT:-$primary_repo}}" \
PM_WORKTREES_ROOT="$worktrees_root" \
PM_CODE_GROUP="$code_group" \
PM_PNPM_BIN="$PNPM_BIN" \
PM_OPERATION_LOCK_HELD=1 \
  "$INSTALLER"

# pm-switch takes this same lock itself. Release our descriptor while keeping
# the maintenance marker in place, so queued UI requests and normal CLI calls
# cannot race the authoritative release switch.
flock -u 9
exec 9>&-
operation_lock_held=0

say "Migrating, building, restarting, and verifying $BRANCH as $MONITOR_USER"
sudo -n -H -u "$MONITOR_USER" -- env PM_DEPLOY_MAINTENANCE_BYPASS=1 \
  /usr/local/sbin/pm-switch --database=worktree "$WORKTREE"

say "Release status"
sudo -n -H -u "$MONITOR_USER" -- env PM_DEPLOY_MAINTENANCE_BYPASS=1 \
  /usr/local/sbin/pm-switch status
curl -fsS -o /dev/null "http://127.0.0.1:${PORT:-3000}/login" \
  || die "live /login verification failed"

active_env="${PM_ACTIVE_ENV_FILE:-${PM_DEPLOY_ACTIVE_ENV_FILE:-/etc/default/pm-active-worktree}}"
if [[ -r "$active_env" ]]; then
  database_url="$(sed -n 's/^DATABASE_URL=//p' "$active_env" | tail -1)"
  if [[ -n "$database_url" ]]; then
    sudo -n -H -u "$MONITOR_USER" -- env DATABASE_URL="$database_url" \
      "$PNPM_BIN" --dir "$APP_DIR" exec prisma migrate status
  fi
fi

rmdir "$maintenance_file"
maintenance_owned=0
trap - EXIT
say "Release complete: $BRANCH is live and its database is migrated"
