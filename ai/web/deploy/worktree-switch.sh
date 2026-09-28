#!/usr/bin/env bash
#
# worktree-switch.sh — generic, registry-driven worktree live-preview switch.
#
# One script for every switchable project. It reads the project's "how to
# switch" contract from /etc/worktree-preview/<key>.env (the host mirror of
# ai/web/lib/deploy/switch-registry.ts) and dispatches on DRIVER:
#
#   node-service   (Next.js + per-branch SQLite): fork the branch DB from the
#                  canonical seed, run that branch's migrations against the fork,
#                  build, then flip the served unit's WorkingDirectory + DB and
#                  restart — the one privileged step is worktree-preview-apply.
#   nginx-docroot  (PHP/Joomla, shared MySQL): repoint the docroot symlink at
#                  the chosen worktree and reload nginx — privileged step is
#                  worktree-docroot-apply. No build, no per-branch DB.
#
# The unprivileged build/DB work runs as the caller; only the final flip is
# delegated to a root helper guarded by a strict env-file allow-list, so a
# non-root caller can never steer the live site at an arbitrary path.
#
# Usage:
#   worktree-switch.sh <key> <branch|worktree-path>   # build (if needed) + go live
#   worktree-switch.sh <key> status
#   worktree-switch.sh <key> off                       # take the site down (free resources)
#   worktree-switch.sh <key> on                        # bring a stopped site back up
set -euo pipefail

ENV_DIR=/etc/worktree-preview
log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Runners can operate worktrees owned by another member of the shared code
# group. Scope Git's trust to this exact real path for this invocation only.
git_in() {
  local repo="$1" safe
  shift
  safe="$(readlink -f "$repo" 2>/dev/null)" || return 1
  git -c "safe.directory=$safe" -C "$safe" "$@"
}

KEY="${1:?usage: worktree-switch.sh <key> <branch|status|off|on>}"
ACTION="${2:?usage: worktree-switch.sh <key> <branch|status|off|on>}"
SOURCE_BRANCH="${3:-}" # Runner-selected existing local branch, never a new branch.
[[ "$KEY" =~ ^[a-z0-9_-]+$ ]] || die "bad key '$KEY'"
ENV_FILE="$ENV_DIR/$KEY.env"
[[ -r "$ENV_FILE" ]] || die "no env file $ENV_FILE (install the project's contract first)"
set -a; . "$ENV_FILE"; set +a

DRIVER="${DRIVER:?DRIVER missing in $ENV_FILE}"
WT_ROOT="$(readlink -f "${WORKTREES_ROOT:?WORKTREES_ROOT}")" || die "WORKTREES_ROOT unresolved"
APP_SUBDIR="${APP_SUBDIR:-}"
PREVIEW_APPLY="${PREVIEW_APPLY_HELPER:-/usr/local/sbin/worktree-preview-apply}"
DOCROOT_APPLY="${DOCROOT_APPLY_HELPER:-/usr/local/sbin/worktree-docroot-apply}"

# Serialize switches and local cleanup. The installer creates this regular
# file under a root-owned parent so shared worktree users cannot replace it.
LOCK_FILE="${WORKTREE_LOCK_FILE:?WORKTREE_LOCK_FILE missing in $ENV_FILE}"
[[ -f "$LOCK_FILE" && ! -L "$LOCK_FILE" ]] || die "worktree operation lock missing: $LOCK_FILE (run worktree-preview-install.sh)"
exec 9<>"$LOCK_FILE"
flock -x 9

# ---- resolve a target argument to an absolute worktree root ---------------
resolve_worktree() {
  local t="$1" p name expected common repo_common
  if [[ -n "$SOURCE_BRANCH" ]]; then
    git_in "$REPO" check-ref-format --branch "$SOURCE_BRANCH" >/dev/null || die "invalid branch"
    git_in "$REPO" show-ref --verify --quiet "refs/heads/$SOURCE_BRANCH" || die "local branch no longer exists: $SOURCE_BRANCH"
    name="${SOURCE_BRANCH//\//_}"
    case "$name" in on|off|status) name="preview-$name" ;; esac
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "unsupported worktree name"
    expected="$WT_ROOT/$name"
    [[ "$t" == "$expected" ]] || die "branch/worktree target mismatch"
    # A stale request must never adopt or replace a colliding path.
    [[ ! -e "$expected" && ! -L "$expected" ]] || die "worktree target already exists; refresh the preview list"
    log "Preparing worktree for $SOURCE_BRANCH …" >&2
    git_in "$REPO" worktree add -- "$expected" "$SOURCE_BRANCH" >&2 || die "could not prepare worktree for $SOURCE_BRANCH"
  fi
  if   [[ -d "$t" ]];            then p="$t"
  elif [[ -d "$WT_ROOT/$t" ]];   then p="$WT_ROOT/$t"
  else die "cannot resolve worktree '$t' (looked for ./$t and $WT_ROOT/$t)"; fi
  p="$(readlink -f "$p")" || die "worktree path does not resolve: $t"
  [[ "$p" == "$WT_ROOT"/* ]] || die "refused: $p not under $WT_ROOT"
  [[ "$(git_in "$p" rev-parse --show-toplevel)" == "$p" && -f "$p/.git" ]] || die "not a registered linked worktree: $p"
  common="$(git_in "$p" rev-parse --path-format=absolute --git-common-dir)"
  repo_common="$(git_in "$REPO" rev-parse --path-format=absolute --git-common-dir)"
  [[ "$(readlink -f "$common")" == "$(readlink -f "$repo_common")" ]] || die "worktree belongs to another repository"
  printf '%s\n' "$p"
}

app_dir_for() {  # worktree root -> built/served app dir
  local wt="$1"
  if [[ -n "$APP_SUBDIR" ]]; then printf '%s\n' "$wt/$APP_SUBDIR"; else printf '%s\n' "$wt"; fi
}

branch_of() { git_in "$1" rev-parse --abbrev-ref HEAD 2>/dev/null || true; }

# ===========================================================================
# node-service driver
# ===========================================================================
node_status() {
  local wd; wd="$(systemctl show -p WorkingDirectory --value "${SERVED_UNIT:-worktree-preview@$KEY.service}" 2>/dev/null || true)"
  local active; active="$(systemctl is-active "${SERVED_UNIT:-worktree-preview@$KEY.service}" 2>/dev/null || echo unknown)"
  local wt="$wd"; [[ -n "$APP_SUBDIR" && "$wd" == */"$APP_SUBDIR" ]] && wt="${wd%/$APP_SUBDIR}"
  printf '%s [node-service]\n  unit:     %s\n  active:   %s\n  appdir:   %s\n  branch:   %s\n' \
    "$KEY" "${SERVED_UNIT:-worktree-preview@$KEY.service}" "$active" "${wd:-<none>}" "$(branch_of "$wt" || echo '?')"
}

node_switch() {
  local wt app branch slug db_url
  wt="$(resolve_worktree "$1")"
  app="$(app_dir_for "$wt")"
  [[ -d "$app" ]] || die "app dir not found: $app"
  branch="$(branch_of "$wt")"; [[ -n "$branch" && "$branch" != "HEAD" ]] || die "cannot resolve branch for $wt"
  slug="${branch//\//_}"

  # New preview worktrees share the configured runtime environment. Never
  # overwrite a worktree's own configuration or copy secrets into source.
  local shared_env="${PREVIEW_ENV_FILE:-$WT_ROOT/main/${APP_SUBDIR:+$APP_SUBDIR/}.env}"
  if [[ ! -e "$app/.env" && ! -L "$app/.env" && -f "$shared_env" ]]; then
    ln -s "$shared_env" "$app/.env"
  fi
  if [[ ! -d "$app/node_modules" ]]; then
    log "Installing dependencies in $app …"
    ( cd "$app" && pnpm install --frozen-lockfile )
  fi

  db_url="-"
  if [[ "${DB_ENGINE:-none}" == "sqlite" ]]; then
    local db_root canonical branch_db
    db_root="$(readlink -f "${DB_ROOT:?DB_ROOT}")" || die "DB_ROOT unresolved"
    canonical="${CANONICAL_DB:?CANONICAL_DB}"
    branch_db="$db_root/wt-$slug.db"
    command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 required for per-branch DB forks"
    mkdir -p "$db_root"
    if [[ ! -f "$branch_db" ]]; then
      [[ -f "$canonical" ]] || die "canonical seed DB not found at $canonical"
      log "Forking branch DB $branch_db from $canonical …"
      sqlite3 "$canonical" ".backup '$branch_db'"
    fi
    sqlite3 "$branch_db" 'PRAGMA journal_mode=WAL;' >/dev/null
    chmod g+rw "$branch_db" "$branch_db"-wal "$branch_db"-shm 2>/dev/null || true
    db_url="file:$branch_db"
    log "Applying migrations to $branch_db …"
    ( cd "$app" && DATABASE_URL="$db_url" eval "${MIGRATE_CMD:-pnpm exec prisma migrate deploy}" )
  fi

  # Cross-user safe rebuild: a previous builder (another code-agents member) may
  # own the generated Prisma client. `prisma generate` copyfiles its output and
  # fchmods the destination, which only the file's owner may do, so regenerating
  # over another user's files fails with EPERM. Remove the generated client so
  # this builder writes fresh, self-owned files. Safe because /srv/Code is
  # group-writable (code-agents, setgid, no sticky), so any member can unlink.
  # Mirrors pm-switch.sh's `rm -rf .prisma`; the find handles pnpm/Prisma 7,
  # which nests the client under node_modules/.pnpm/@prisma+client@*/.
  if [[ -d "$app/node_modules" ]]; then
    find "$app/node_modules" -type d -name '.prisma' -prune -exec rm -rf {} + 2>/dev/null || true
  fi

  log "Building $app (branch $branch) …"
  ( cd "$app" && DATABASE_URL="$db_url" eval "${BUILD_CMD:?BUILD_CMD missing}" )
  # Build output dir; default .next, but a project may set a custom Next distDir
  # (WDT uses 'dist') in its env contract. Keep in sync with worktree-preview-apply.
  local out_dir="${BUILD_OUTPUT_DIR:-.next}"
  [[ -d "$app/$out_dir" ]] || die "build did not produce $app/$out_dir"

  log "Flipping ${SERVED_UNIT:-worktree-preview@$KEY.service} -> $app and restarting …"
  sudo -n "$PREVIEW_APPLY" "$KEY" apply "$app" "$db_url"

  log "Verifying on ${HOST:-127.0.0.1}:${PORT:-3000} …"
  local ok=""
  for _ in $(seq 1 40); do
    curl -fsS -o /dev/null "http://${HOST:-127.0.0.1}:${PORT:-3000}/" 2>/dev/null && { ok=1; break; }
    sleep 0.5
  done
  [[ -n "$ok" ]] || die "site did not come up — journalctl -u ${SERVED_UNIT:-worktree-preview@$KEY.service} -n 50"
  log "OK — $KEY now serving $app (branch $branch)."
}

# ===========================================================================
# nginx-docroot driver
# ===========================================================================
docroot_status() {
  local link tgt; link="${CURRENT_SYMLINK:?CURRENT_SYMLINK}"
  if [[ -L "$link" ]]; then tgt="$(readlink -f "$link" 2>/dev/null || true)"; else tgt="<no symlink: OFF>"; fi
  printf '%s [nginx-docroot]\n  docroot:  %s\n  target:   %s\n  branch:   %s\n' \
    "$KEY" "$link" "$tgt" "$( [[ -d "$tgt" ]] && branch_of "$tgt" || echo '?')"
}

docroot_switch() {
  local wt; wt="$(resolve_worktree "$1")"
  log "Repointing ${CURRENT_SYMLINK} -> $wt and reloading nginx …"
  sudo -n "$DOCROOT_APPLY" "$KEY" apply "$wt"
  log "OK — $KEY docroot now serves $wt (branch $(branch_of "$wt" || echo '?'))."
}

# ===========================================================================
# dispatch
# ===========================================================================
case "$DRIVER" in
  node-service)
    case "$ACTION" in
      status) node_status ;;
      off)    sudo -n "$PREVIEW_APPLY" "$KEY" stop ;;
      on)     sudo -n "$PREVIEW_APPLY" "$KEY" start ;;
      *)      node_switch "$ACTION" ;;
    esac ;;
  nginx-docroot)
    case "$ACTION" in
      status) docroot_status ;;
      off)    sudo -n "$DOCROOT_APPLY" "$KEY" off ;;
      on)     die "nginx-docroot 'on' needs a target branch: worktree-switch.sh $KEY <branch>" ;;
      *)      docroot_switch "$ACTION" ;;
    esac ;;
  *) die "unknown DRIVER '$DRIVER' in $ENV_FILE (node-service|nginx-docroot)" ;;
esac
