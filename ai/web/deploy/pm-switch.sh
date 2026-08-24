#!/usr/bin/env bash
#
# pm-switch.sh — build a chosen worktree and make pm.service/pm-consumer use it
# ("switchable single site": exactly one worktree is live at a time; each
# worktree has its own forked SQLite DB so code and Prisma schema switch
# together).
#
# Run by pm-switch-runner (as the monitor) or by hand (as any code-agent who
# can `sudo pm-apply-worktree`). The single privileged step — systemd drop-ins
# + daemon-reload + restarts — is delegated to /usr/local/sbin/pm-apply-worktree.
#
# Usage:
#   pm-switch.sh [--database=worktree|main] <worktree-name | path>
#   pm-switch.sh status
#
# See deploy/MULTI_AGENT_WORKTREES.md.
set -euo pipefail

die()  { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

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

WT_DIR="${PM_WORKTREES_ROOT:-${PM_DEPLOY_WORKTREES_ROOT:-/srv/Code/environment.worktrees}}"
PNPM="${PM_PNPM:-${PM_DEPLOY_PNPM_BIN:-/usr/local/bin/pnpm}}"
PORT="${PORT:-3000}"
HOST="${PM_HOST:-127.0.0.1}"
PM_ENV_FILE="${PM_SYSTEM_ENV_FILE:-${PM_DEPLOY_SYSTEM_ENV_FILE:-/etc/default/pm}}"
APPLY="${PM_APPLY_HELPER:-/usr/local/sbin/pm-apply-worktree}"
PM_DB_DIR="${PM_DB_DIR:-${PM_DEPLOY_DB_ROOT:-/srv/Data/pm}}"
PM_CANONICAL_DB="${PM_CANONICAL_DB:-${PM_DEPLOY_CANONICAL_DB:-$PM_DB_DIR/pm.db}}"
SWITCH_DIR="${PM_SWITCH_DIR:-${PM_DEPLOY_SWITCH_DIR:-/var/lib/pm/switch}}"
MAINTENANCE_FILE="$SWITCH_DIR/.maintenance"

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }

# The deployment runner intentionally builds worktrees owned by a different
# code-agents member on some hosts. Trust only the exact repository/worktree
# used by this invocation; never mutate the monitor user's global Git config.
git_in() {
  local repo="$1" safe
  shift
  safe="$(readlink -f "$repo" 2>/dev/null)" || return 1
  git -c "safe.directory=$safe" -C "$safe" "$@"
}

if [[ -e "$MAINTENANCE_FILE" && "${PM_DEPLOY_MAINTENANCE_BYPASS:-0}" != 1 ]]; then
  die "PM deployment maintenance is active; retry after $MAINTENANCE_FILE is removed"
fi

# Serialize switches and local cleanup. The installer creates this regular
# file under a root-owned parent so shared worktree users cannot replace it.
LOCK_FILE="${PM_WORKTREE_LOCK:-${PM_DEPLOY_WORKTREE_LOCK:-/var/lib/worktree-locks/environment.lock}}"
[[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" ]] || die "worktree operation lock missing: $LOCK_FILE (run install-pm-switch.sh)"
exec 9<>"$LOCK_FILE"
flock -x 9

run_build() {
  ( cd "$APP_DIR" && DATABASE_URL="$BRANCH_DB_URL" "$PNPM" build )
}

is_transient_next_trace_failure() {
  local log_file="$1"
  grep -Eq "ENOENT:.*(\\.nft\\.json|pages-manifest\\.json)" "$log_file"
}

served_worktree() {
  local wd; wd="$(systemctl show -p WorkingDirectory --value pm.service 2>/dev/null || true)"
  [[ "$wd" == */ai/web/.next/standalone ]] && printf '%s\n' "${wd%/ai/web/.next/standalone}"
}

consumer_worktree() {
  local wd; wd="$(systemctl show -p WorkingDirectory --value pm-consumer.service 2>/dev/null || true)"
  [[ "$wd" == */ai/web ]] && printf '%s\n' "${wd%/ai/web}"
}

active_database_url() {
  local env_file="${PM_ACTIVE_ENV_FILE:-${PM_DEPLOY_ACTIVE_ENV_FILE:-/etc/default/pm-active-worktree}}"
  if [[ -r "$env_file" ]]; then
    sed -n 's/^DATABASE_URL=//p' "$env_file" | tail -1
  elif sudo -n test -r "$env_file" 2>/dev/null; then
    sudo -n sed -n 's/^DATABASE_URL=//p' "$env_file" | tail -1
  fi
}

file_url_path() {
  case "${1:-}" in
    file://*) printf '%s\n' "${1#file://}" ;;
    file:*)   printf '%s\n' "${1#file:}" ;;
  esac
}

usage() {
  printf '%s\n' \
    "usage: pm-switch.sh [--database=worktree|main] <worktree-name | path>" \
    "       pm-switch.sh status"
}

DATABASE_SELECTION="${PM_SWITCH_DATABASE:-auto}"
TARGET=""
while (($#)); do
  case "$1" in
    status|--status)
      [[ -z "$TARGET" ]] || die "status does not accept a worktree target"
      TARGET="status"
      ;;
    --database=*) DATABASE_SELECTION="${1#--database=}" ;;
    --database)
      shift
      [[ -n "${1:-}" ]] || die "--database requires a value"
      DATABASE_SELECTION="$1"
      ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *)
      [[ -z "$TARGET" ]] || die "only one worktree target may be supplied"
      TARGET="$1"
      ;;
  esac
  shift
done
[[ -n "$TARGET" ]] || { usage >&2; exit 1; }

if [[ "$TARGET" == "status" ]]; then
  wt="$(served_worktree || true)"; [[ -n "$wt" ]] || die "cannot read pm.service WorkingDirectory"
  consumer_wt="$(consumer_worktree || true)"
  db_url="$(active_database_url || true)"
  consumer_active="$(systemctl is-active pm-consumer.service 2>/dev/null || echo unknown)"
  printf 'pm.service serving:\n  worktree: %s\n  branch:   %s\n  db:       %s\n  active:   %s\npm-consumer.service:\n  worktree: %s\n  active:   %s\n' \
    "$wt" "$(git_in "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')" "$db_url" "$(systemctl is-active pm.service)" \
    "${consumer_wt:-unknown}" "$consumer_active"
  exit 0
fi

# ---- resolve target -> APP_DIR (an ai/web dir) ----------------------------
if   [[ -d "$TARGET/ai/web" ]];         then APP_DIR="$TARGET/ai/web"
elif [[ -d "$WT_DIR/$TARGET/ai/web" ]]; then APP_DIR="$WT_DIR/$TARGET/ai/web"
elif [[ -f "$TARGET/package.json" ]];   then APP_DIR="$TARGET"
else die "cannot resolve worktree '$TARGET' (looked for ./ai/web, $WT_DIR/$TARGET/ai/web, or an ai/web path)"
fi
APP_DIR="$(readlink -f "$APP_DIR")"
STANDALONE="$APP_DIR/.next/standalone"
WT_ROOT="${APP_DIR%/ai/web}"
BRANCH="$(git_in "$WT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
[[ -n "$BRANCH" && "$BRANCH" != "HEAD" ]] || die "cannot resolve branch for $WT_ROOT"
WORKTREE_NAME="$(basename "$WT_ROOT")"
[[ -n "$WORKTREE_NAME" && "$WORKTREE_NAME" != "." && "$WORKTREE_NAME" != ".." ]] \
  || die "cannot resolve database identity for $WT_ROOT"
# The UI and CLI switch a named worktree, not a branch ref. A managed worktree
# can temporarily host an Epic integration branch (for example, worktree
# `main` on branch `phase-e`). Keying the DB by the checked-out branch makes
# `pm-switch main` silently select wt-phase-e.db and appear to lose production
# records. Keep the database attached to the stable worktree identity instead.
WORKTREE_SLUG="${WORKTREE_NAME//\//_}"
case "$DATABASE_SELECTION" in
  auto)
    if [[ -n "${PM_BRANCH_DB:-}" ]]; then
      DATABASE_SELECTION="environment"
      BRANCH_DB="$PM_BRANCH_DB"
    elif [[ "$WORKTREE_NAME" == "main" && "$BRANCH" != "main" ]]; then
      die "database intent is ambiguous: worktree 'main' currently checks out branch '$BRANCH'; rerun with --database=main (wt-main.db) or another explicit --database selection"
    else
      DATABASE_SELECTION="worktree"
      BRANCH_DB="$PM_DB_DIR/wt-$WORKTREE_SLUG.db"
    fi
    ;;
  worktree)
    BRANCH_DB="$PM_DB_DIR/wt-$WORKTREE_SLUG.db"
    ;;
  main)
    [[ "$WORKTREE_NAME" == "main" ]] || die "--database=main is valid only for the main worktree"
    BRANCH_DB="$PM_DB_DIR/wt-main.db"
    ;;
  *) die "invalid --database selection '$DATABASE_SELECTION' (use worktree or main)" ;;
esac
[[ "$BRANCH_DB" == /* ]] || die "database path must be absolute: $BRANCH_DB"
db_root_real="$(readlink -m "$PM_DB_DIR")"
db_requested_real="$(readlink -m "$BRANCH_DB")"
[[ "$db_requested_real" == "$db_root_real"/* ]] \
  || die "database must remain below the configured PM DB root $db_root_real"
BRANCH_DB="$db_requested_real"
BRANCH_DB_URL="file:$BRANCH_DB"

[[ -x "$PNPM" ]]                 || die "pnpm not executable at $PNPM (set PM_PNPM)."
[[ -d "$APP_DIR/node_modules" ]] || die "no node_modules in $APP_DIR — run 'pnpm install' there (worktrees don't share it; created via: claim-branch environment <branch>)."
[[ -x "$APPLY" ]]                || die "privileged helper missing: $APPLY (run ai/web/deploy/install-pm-switch.sh)."
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 is required for per-worktree DB forks."

# 0. Resolve and validate database intent before stopping either live service.
log "Preflight: worktree=$WORKTREE_NAME branch=$BRANCH database=$DATABASE_SELECTION path=$BRANCH_DB …"
mkdir -p "$PM_DB_DIR"
if [[ ! -f "$BRANCH_DB" ]]; then
  [[ "$DATABASE_SELECTION" == "worktree" || "$DATABASE_SELECTION" == "main" || "$DATABASE_SELECTION" == "environment" ]] \
    || die "managed worktree database does not exist: $BRANCH_DB"
  [[ -f "$PM_CANONICAL_DB" ]] || die "canonical DB not found at $PM_CANONICAL_DB"
  sqlite3 "$PM_CANONICAL_DB" ".backup '$BRANCH_DB'"
fi
[[ -f "$APP_DIR/prisma/schema.prisma" && -d "$APP_DIR/prisma/migrations" ]] \
  || die "Prisma schema or migration history is missing from $APP_DIR"
quick_check="$(sqlite3 "$BRANCH_DB" 'PRAGMA quick_check;' 2>&1)" \
  || die "database preflight failed for $BRANCH_DB: $quick_check"
[[ "$quick_check" == "ok" ]] || die "database quick_check failed for $BRANCH_DB: $quick_check"
DEPLOY_COMMIT="$(git_in "$WT_ROOT" rev-parse HEAD)"
DEPLOY_DIRTY_COUNT="$(git_in "$WT_ROOT" status --porcelain=v1 | wc -l | tr -d ' ')"
log "Preparing and migrating $BRANCH_DB (commit $DEPLOY_COMMIT; dirty paths $DEPLOY_DIRTY_COUNT) …"
branch_db_real="$(readlink -f "$BRANCH_DB")"
[[ "$branch_db_real" == "$db_root_real"/* ]] \
  || die "resolved database escapes the configured PM DB root: $branch_db_real"
served_wt="$(served_worktree || true)"
active_db_url="$(active_database_url || true)"
active_db_path="$(file_url_path "$active_db_url" || true)"
active_db_real=""
if [[ -n "$active_db_path" ]]; then
  active_db_real="$(readlink -f "$active_db_path" 2>/dev/null || true)"
fi
if [[ "$served_wt" == "$WT_ROOT" || "$active_db_real" == "$branch_db_real" ]]; then
  log "Target worktree or DB is already live; stopping PM services before migrate/build to avoid SQLite and build-tree locks…"
  sudo -n "$APPLY" --stop-live "$STANDALONE" "$BRANCH_DB_URL"
fi
sqlite3 "$BRANCH_DB" 'PRAGMA journal_mode=WAL;' >/dev/null
chmod g+rw "$BRANCH_DB" "$BRANCH_DB"-wal "$BRANCH_DB"-shm 2>/dev/null || true
DATABASE_URL="$BRANCH_DB_URL" "$PNPM" --dir "$APP_DIR" exec prisma migrate deploy

# 1. Clean the generated Prisma client so `prisma generate` writes files owned
#    by THIS builder. Node's copyfile fchmod's the destination, and only the
#    owner may chmod — so overwriting a prior (different) builder's .prisma
#    fails with EPERM. .prisma is regenerated, so removing it is always safe.
log "Cleaning generated Prisma client…"
sudo -n "$APPLY" --prepare-build "$APP_DIR" "$BRANCH_DB_URL"
rm -rf "$APP_DIR"/node_modules/.pnpm/@prisma+client*/node_modules/.prisma 2>/dev/null || true

# 2. Build. Group-collaborative /srv/Code perms let any code-agent build; the
#    serving user reads the bundle through the shared code-agents group.
log "Building $APP_DIR …"
build_log="$(mktemp)"
if ! run_build > >(tee "$build_log") 2> >(tee -a "$build_log" >&2); then
  if is_transient_next_trace_failure "$build_log"; then
    warn "Next.js reported a transient trace artifact ENOENT; retrying build once without re-cleaning."
    run_build || die "build failed after retry"
  else
    rm -f "$build_log"
    die "build failed"
  fi
fi
rm -f "$build_log"
[[ -f "$STANDALONE/server.js" ]] || die "build did not produce $STANDALONE/server.js"

# 3. The only privileged step.
log "Pointing pm.service and pm-consumer.service at $APP_DIR with $BRANCH_DB_URL and restarting…"
sudo -n "$APPLY" "$STANDALONE" "$BRANCH_DB_URL"

# 4. Verify the live site + that its hashed assets serve.
log "Verifying…"
ok=""; for _ in $(seq 1 30); do curl -fsS -o /dev/null "http://$HOST:$PORT/login" 2>/dev/null && { ok=1; break; }; sleep 0.5; done
[[ -n "$ok" ]] || die "server did not come up on $HOST:$PORT — check: journalctl -u pm.service -n 50"
consumer_wt="$(consumer_worktree || true)"
[[ "$consumer_wt" == "$WT_ROOT" ]] || die "pm-consumer.service is not running from $WT_ROOT (got: ${consumer_wt:-unknown})"
consumer_active="$(systemctl is-active pm-consumer.service 2>/dev/null || echo unknown)"
[[ "$consumer_active" == "active" ]] || die "pm-consumer.service is not active (got: $consumer_active)"
ref="$(curl -fsS "http://$HOST:$PORT/login" | grep -oE '/_next/static/css/[a-f0-9]+\.css' | head -1 || true)"
if [[ -n "$ref" ]]; then
  code="$(curl -fsS -o /dev/null -w '%{http_code}' "http://$HOST:$PORT$ref" 2>/dev/null || echo 000)"
  [[ "$code" == "200" ]] \
    && log "OK — pm.service and pm-consumer.service now use $APP_DIR (HTML references $ref, serves 200). Hard-refresh the site." \
    || die "asset mismatch: HTML references $ref but it returns HTTP $code"
else
  log "OK — pm.service and pm-consumer.service now use $APP_DIR (/login responded)."
fi

# 5. Persist the exact code/database pairing only after end-to-end health
# verification. This receipt makes post-incident diagnosis independent of
# shell history or the branch currently attached to the worktree.
RECEIPT_DIR="$SWITCH_DIR/deployment-receipts"
mkdir -p "$RECEIPT_DIR"
DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LAST_MIGRATION="$(sqlite3 "$BRANCH_DB" "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1;" 2>/dev/null || true)"
RECEIPT_FILE="$RECEIPT_DIR/${DEPLOYED_AT//:/}-${WORKTREE_SLUG}-${DEPLOY_COMMIT:0:12}.receipt"
RECEIPT_TMP="$(mktemp "$RECEIPT_DIR/.deployment.XXXXXX")"
{
  printf 'deployed_at=%s\n' "$DEPLOYED_AT"
  printf 'worktree=%s\n' "$WORKTREE_NAME"
  printf 'worktree_path=%s\n' "$WT_ROOT"
  printf 'branch=%s\n' "$BRANCH"
  printf 'commit=%s\n' "$DEPLOY_COMMIT"
  printf 'dirty_path_count=%s\n' "$DEPLOY_DIRTY_COUNT"
  printf 'database_selection=%s\n' "$DATABASE_SELECTION"
  printf 'database_path=%s\n' "$BRANCH_DB"
  printf 'last_migration=%s\n' "$LAST_MIGRATION"
  printf 'pm_service=active\n'
  printf 'pm_consumer_service=active\n'
} > "$RECEIPT_TMP"
chmod 0640 "$RECEIPT_TMP"
mv -f "$RECEIPT_TMP" "$RECEIPT_FILE"
LAST_RECEIPT_TMP="$(mktemp "$SWITCH_DIR/.last-deployment.XXXXXX")"
cp "$RECEIPT_FILE" "$LAST_RECEIPT_TMP"
mv -f "$LAST_RECEIPT_TMP" "$SWITCH_DIR/last-deployment.receipt"
log "Deployment receipt: $RECEIPT_FILE"
