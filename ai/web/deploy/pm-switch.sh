#!/usr/bin/env bash
#
# pm-switch.sh — point the single live PM site (pm.service) at a chosen
# worktree's build and restart it.
#
# "Switchable single site" model
# ------------------------------
# Exactly ONE worktree is served at a time. All worktrees share the same data
# and runtime config: DATABASE_URL is an absolute path and the full runtime env
# lives in the systemd EnvironmentFile /etc/default/pm — so switching changes
# only the CODE being served, not the database or secrets. No per-worktree
# .env.local seeding is needed.
#
# Mechanism: a systemd drop-in (20-active-worktree.conf) overrides pm.service's
# WorkingDirectory to the chosen worktree's .next/standalone (a LITERAL path —
# a symlinked WorkingDirectory fails CHDIR under the unit's strict sandbox).
# Switching = rebuild the target, rewrite the drop-in, daemon-reload, restart.
# ReadWritePaths are NOT touched: the DB lives at an absolute path that is
# already covered, and the served bundle runs read-only.
#
# Usage:
#   ai/web/deploy/pm-switch.sh <worktree-name | path-to-worktree | path-to-ai/web>
#
# Run as the build user (zeh): owns node_modules, has passwordless sudo to the
# app user (karen) + systemctl. See deploy/MULTI_AGENT_WORKTREES.md.
set -euo pipefail

WT_DIR="${ENV_WORKTREES:-/srv/Code/environment.worktrees}"
APP_USER="${PM_APP_USER:-karen}"
PNPM="${PM_PNPM:-/usr/local/bin/pnpm}"
PORT="${PORT:-3000}"
HOST="${PM_HOST:-127.0.0.1}"
PM_ENV_FILE="${PM_SYSTEM_ENV_FILE:-/etc/default/pm}"
DROPIN_DIR="/etc/systemd/system/pm.service.d"
DROPIN="$DROPIN_DIR/20-active-worktree.conf"

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -n "${1:-}" ]] || die "usage: pm-switch.sh <worktree-name | path>   (or: pm-switch.sh status)"

# Which worktree is pm.service serving? Derived from the unit's effective
# WorkingDirectory (…/ai/web/.next/standalone -> worktree root).
served_worktree() {
  local wd; wd="$(systemctl show -p WorkingDirectory --value pm.service 2>/dev/null || true)"
  [[ "$wd" == */ai/web/.next/standalone ]] && printf '%s\n' "${wd%/ai/web/.next/standalone}"
}

if [[ "$1" == "status" || "$1" == "--status" ]]; then
  wt="$(served_worktree || true)"
  [[ -n "$wt" ]] || die "could not read pm.service WorkingDirectory — is pm.service installed?"
  branch="$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  printf 'pm.service is serving:\n  worktree: %s\n  branch:   %s\n  active:   %s\n' \
    "$wt" "$branch" "$(systemctl is-active pm.service)"
  exit 0
fi

TARGET="$1"

# ---- resolve target -> APP_DIR (an ai/web directory) ----------------------
if   [[ -d "$TARGET/ai/web" ]];         then APP_DIR="$TARGET/ai/web"
elif [[ -d "$WT_DIR/$TARGET/ai/web" ]]; then APP_DIR="$WT_DIR/$TARGET/ai/web"
elif [[ -f "$TARGET/package.json" ]];   then APP_DIR="$TARGET"
else die "cannot resolve worktree '$TARGET' (looked for ./ai/web, $WT_DIR/$TARGET/ai/web, or an ai/web path)"
fi
APP_DIR="$(readlink -f "$APP_DIR")"
STANDALONE="$APP_DIR/.next/standalone"

# ---- preflight ------------------------------------------------------------
[[ -x "$PNPM" ]]                 || die "pnpm not executable at $PNPM (set PM_PNPM)."
[[ -d "$APP_DIR/node_modules" ]] || die "no node_modules in $APP_DIR — run 'pnpm install' there (worktrees don't share node_modules). Worktrees are created with: claim-branch environment <branch>."
sudo -n -u "$APP_USER" true 2>/dev/null  || die "need passwordless sudo to '$APP_USER'."
sudo -n systemctl --version >/dev/null 2>&1 || die "need passwordless sudo to systemctl."

# Grant the runtime user traverse/read on the build tree (mirrors
# rebuild-and-restart.sh). The standalone bundle is served read-only.
grant_runtime_access() {
  command -v setfacl >/dev/null 2>&1 || return 0
  local p="$APP_DIR"
  while [[ "$p" != "/" && -n "$p" ]]; do
    setfacl -m "u:$APP_USER:x" "$p" 2>/dev/null || true
    p="$(dirname "$p")"
  done
  [[ -d "$STANDALONE" ]] && setfacl -R -m "u:$APP_USER:rX" "$STANDALONE" 2>/dev/null || true
}

# Rewrite the WorkingDirectory drop-in with the LITERAL standalone path; only
# daemon-reload when it actually changed.
set_dropin() {
  local desired
  desired=$'[Service]\nWorkingDirectory=\nWorkingDirectory='"$STANDALONE"$'\n'
  if [[ "$(sudo -n cat "$DROPIN" 2>/dev/null || true)" != "$desired" ]]; then
    log "Updating $DROPIN (WorkingDirectory -> $STANDALONE)…"
    sudo -n install -d "$DROPIN_DIR"
    printf '%s' "$desired" | sudo -n tee "$DROPIN" >/dev/null
    sudo -n systemctl daemon-reload
  fi
}

# ---- 1. build (as caller — owns node_modules) -----------------------------
log "Building $APP_DIR …"
( cd "$APP_DIR" && "$PNPM" build )
[[ -f "$STANDALONE/server.js" ]] || die "build did not produce $STANDALONE/server.js"
grant_runtime_access

# ---- 2. warn (don't auto-apply) if the target branch has unmigrated schema -
# The DB is shared; auto-migrating could break OTHER worktrees on an older
# schema. Surface drift and let the operator decide.
DB_URL="$(sudo -n grep -E '^DATABASE_URL=' "$PM_ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
if [[ -n "$DB_URL" ]]; then
  if ! DATABASE_URL="$DB_URL" "$PNPM" --dir "$APP_DIR" exec prisma migrate status >"/tmp/pm-switch-migrate.$$" 2>&1; then
    if grep -qiE 'not yet been applied|pending|following migration' "/tmp/pm-switch-migrate.$$"; then
      warn "This worktree has migrations the shared DB does not have — the DB is NOT auto-migrated."
      warn "If the app throws P2022/column errors, apply them deliberately:"
      warn "  sudo -u $APP_USER bash -c 'cd $APP_DIR && set -a && . $PM_ENV_FILE && set +a && $PNPM exec prisma migrate deploy'"
    fi
  fi
  rm -f "/tmp/pm-switch-migrate.$$"
fi

# ---- 3. point the service at this worktree + restart ----------------------
set_dropin
log "Restarting pm.service (now serving $APP_DIR)…"
sudo -n systemctl restart pm.service

# ---- 4. verify ------------------------------------------------------------
log "Waiting for the server to listen…"
ok=""
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://$HOST:$PORT/login" 2>/dev/null; then ok=1; break; fi
  sleep 0.5
done
[[ -n "$ok" ]] || die "server did not come up on $HOST:$PORT — check: journalctl -u pm.service -n 50"

ref="$(curl -fsS "http://$HOST:$PORT/login" | grep -oE '/_next/static/css/[a-f0-9]+\.css' | head -1 || true)"
if [[ -n "$ref" ]]; then
  code="$(curl -fsS -o /dev/null -w '%{http_code}' "http://$HOST:$PORT$ref" 2>/dev/null || echo 000)"
  [[ "$code" == "200" ]] \
    && log "OK — pm.service now serves $APP_DIR (HTML references $ref, serves 200). Hard-refresh the site." \
    || die "asset mismatch: HTML references $ref but it returns HTTP $code"
else
  log "OK — pm.service now serves $APP_DIR (/login responded; could not sample a CSS ref)."
fi
