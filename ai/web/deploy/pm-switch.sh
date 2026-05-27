#!/usr/bin/env bash
#
# pm-switch.sh — build a chosen worktree and make pm.service serve it
# ("switchable single site": exactly one worktree is live at a time; all share
# the same DB + env via /etc/default/pm, so only the served CODE changes).
#
# Run by pm-switch-runner (as the monitor) or by hand (as any code-agent who
# can `sudo pm-apply-worktree`). The single privileged step — drop-in +
# daemon-reload + restart — is delegated to /usr/local/sbin/pm-apply-worktree.
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

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

served_worktree() {
  local wd; wd="$(systemctl show -p WorkingDirectory --value pm.service 2>/dev/null || true)"
  [[ "$wd" == */ai/web/.next/standalone ]] && printf '%s\n' "${wd%/ai/web/.next/standalone}"
}

[[ -n "${1:-}" ]] || die "usage: pm-switch.sh <worktree-name | path>   (or: status)"

if [[ "$1" == "status" || "$1" == "--status" ]]; then
  wt="$(served_worktree || true)"; [[ -n "$wt" ]] || die "cannot read pm.service WorkingDirectory"
  printf 'pm.service serving:\n  worktree: %s\n  branch:   %s\n  active:   %s\n' \
    "$wt" "$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')" "$(systemctl is-active pm.service)"
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

[[ -x "$PNPM" ]]                 || die "pnpm not executable at $PNPM (set PM_PNPM)."
[[ -d "$APP_DIR/node_modules" ]] || die "no node_modules in $APP_DIR — run 'pnpm install' there (worktrees don't share it; created via: claim-branch environment <branch>)."
[[ -x "$APPLY" ]]                || die "privileged helper missing: $APPLY (run ai/web/deploy/install-pm-switch.sh)."

# 1. Clean the generated Prisma client so `prisma generate` writes files owned
#    by THIS builder. Node's copyfile fchmod's the destination, and only the
#    owner may chmod — so overwriting a prior (different) builder's .prisma
#    fails with EPERM. .prisma is regenerated, so removing it is always safe.
log "Cleaning generated Prisma client…"
rm -rf "$APP_DIR"/node_modules/.pnpm/@prisma+client*/node_modules/.prisma 2>/dev/null || true

# 2. Build. Group-collaborative /srv/Code perms let any code-agent build; the
#    serving user reads the bundle through the shared code-agents group.
log "Building $APP_DIR …"
( cd "$APP_DIR" && "$PNPM" build )
[[ -f "$STANDALONE/server.js" ]] || die "build did not produce $STANDALONE/server.js"

# 3. Warn (don't auto-apply) on schema drift — the DB is shared across worktrees.
DB_URL="$(grep -E '^DATABASE_URL=' "$PM_ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
if [[ -n "$DB_URL" ]] && ! DATABASE_URL="$DB_URL" "$PNPM" --dir "$APP_DIR" exec prisma migrate status >"/tmp/pm-switch-migrate.$$" 2>&1; then
  if grep -qiE 'not yet been applied|pending|following migration' "/tmp/pm-switch-migrate.$$"; then
    warn "Target branch has migrations the shared DB lacks — NOT auto-applied (could break other worktrees)."
    warn "Apply deliberately: cd $APP_DIR && set -a && . $PM_ENV_FILE && set +a && $PNPM exec prisma migrate deploy"
  fi
fi
rm -f "/tmp/pm-switch-migrate.$$" 2>/dev/null || true

# 4. The only privileged step.
log "Pointing pm.service at $APP_DIR and restarting…"
sudo -n "$APPLY" "$STANDALONE"

# 5. Verify the live site + that its hashed assets serve.
log "Verifying…"
ok=""; for _ in $(seq 1 30); do curl -fsS -o /dev/null "http://$HOST:$PORT/login" 2>/dev/null && { ok=1; break; }; sleep 0.5; done
[[ -n "$ok" ]] || die "server did not come up on $HOST:$PORT — check: journalctl -u pm.service -n 50"
ref="$(curl -fsS "http://$HOST:$PORT/login" | grep -oE '/_next/static/css/[a-f0-9]+\.css' | head -1 || true)"
if [[ -n "$ref" ]]; then
  code="$(curl -fsS -o /dev/null -w '%{http_code}' "http://$HOST:$PORT$ref" 2>/dev/null || echo 000)"
  [[ "$code" == "200" ]] \
    && log "OK — pm.service now serves $APP_DIR (HTML references $ref, serves 200). Hard-refresh the site." \
    || die "asset mismatch: HTML references $ref but it returns HTTP $code"
else
  log "OK — pm.service now serves $APP_DIR (/login responded)."
fi
