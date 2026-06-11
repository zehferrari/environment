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
#   pm-switch.sh <worktree-name | path>
#   pm-switch.sh status
#
# See deploy/MULTI_AGENT_WORKTREES.md.
set -euo pipefail

WT_DIR="${PM_WORKTREES_ROOT:-/srv/Code/environment.worktrees}"
PNPM="${PM_PNPM:-/usr/local/bin/pnpm}"
PORT="${PORT:-3000}"
HOST="${PM_HOST:-127.0.0.1}"
PM_ENV_FILE="${PM_SYSTEM_ENV_FILE:-/etc/default/pm}"
APPLY="${PM_APPLY_HELPER:-/usr/local/sbin/pm-apply-worktree}"
PM_DB_DIR="${PM_DB_DIR:-/srv/Data/pm}"
PM_CANONICAL_DB="${PM_CANONICAL_DB:-$PM_DB_DIR/pm.db}"

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

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
  local env_file="${PM_ACTIVE_ENV_FILE:-/etc/default/pm-active-worktree}"
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

[[ -n "${1:-}" ]] || die "usage: pm-switch.sh <worktree-name | path>   (or: status)"

if [[ "$1" == "status" || "$1" == "--status" ]]; then
  wt="$(served_worktree || true)"; [[ -n "$wt" ]] || die "cannot read pm.service WorkingDirectory"
  consumer_wt="$(consumer_worktree || true)"
  db_url="$(active_database_url || true)"
  consumer_active="$(systemctl is-active pm-consumer.service 2>/dev/null || echo unknown)"
  printf 'pm.service serving:\n  worktree: %s\n  branch:   %s\n  db:       %s\n  active:   %s\npm-consumer.service:\n  worktree: %s\n  active:   %s\n' \
    "$wt" "$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')" "$db_url" "$(systemctl is-active pm.service)" \
    "${consumer_wt:-unknown}" "$consumer_active"
  exit 0
fi

# ---- resolve target -> APP_DIR (an ai/web dir) ----------------------------
TARGET="$1"
if   [[ -d "$TARGET/ai/web" ]];         then APP_DIR="$TARGET/ai/web"
elif [[ -d "$WT_DIR/$TARGET/ai/web" ]]; then APP_DIR="$WT_DIR/$TARGET/ai/web"
elif [[ -f "$TARGET/package.json" ]];   then APP_DIR="$TARGET"
else die "cannot resolve worktree '$TARGET' (looked for ./ai/web, $WT_DIR/$TARGET/ai/web, or an ai/web path)"
fi
APP_DIR="$(readlink -f "$APP_DIR")"
STANDALONE="$APP_DIR/.next/standalone"
WT_ROOT="${APP_DIR%/ai/web}"
BRANCH="$(git -C "$WT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
[[ -n "$BRANCH" && "$BRANCH" != "HEAD" ]] || die "cannot resolve branch for $WT_ROOT"
BRANCH_SLUG="${BRANCH//\//_}"
BRANCH_DB="${PM_BRANCH_DB:-$PM_DB_DIR/wt-$BRANCH_SLUG.db}"
BRANCH_DB_URL="file:$BRANCH_DB"

[[ -x "$PNPM" ]]                 || die "pnpm not executable at $PNPM (set PM_PNPM)."
[[ -d "$APP_DIR/node_modules" ]] || die "no node_modules in $APP_DIR — run 'pnpm install' there (worktrees don't share it; created via: claim-branch environment <branch>)."
[[ -x "$APPLY" ]]                || die "privileged helper missing: $APPLY (run ai/web/deploy/install-pm-switch.sh)."
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 is required for per-worktree DB forks."

# 0. Ensure this branch has an isolated DB fork, then apply this branch's
#    migrations to that fork only.
log "Preparing DB fork $BRANCH_DB for branch $BRANCH …"
mkdir -p "$PM_DB_DIR"
if [[ ! -f "$BRANCH_DB" ]]; then
  [[ -f "$PM_CANONICAL_DB" ]] || die "canonical DB not found at $PM_CANONICAL_DB"
  sqlite3 "$PM_CANONICAL_DB" ".backup '$BRANCH_DB'"
fi
branch_db_real="$(readlink -f "$BRANCH_DB")"
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
