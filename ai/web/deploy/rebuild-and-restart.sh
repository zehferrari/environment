#!/usr/bin/env bash
#
# rebuild-and-restart.sh — build the PM standalone bundle and restart the
# live server in ONE step.
#
# Why this exists
# ---------------
# `next build` deletes and recreates .next/standalone, and the running Node
# process caches the HTML/RSC payloads that reference content-hashed asset
# names (e.g. /_next/static/css/<hash>.css). So a rebuild that is NOT
# immediately followed by a restart leaves the live site broken: the old
# process serves stale HTML *and* can no longer read its own static files
# (its working directory was deleted), producing ChunkLoadError and
# "CSS MIME type" errors in the browser until someone restarts it.
#
# On agents.vixi.au nginx proxies EVERYTHING — including /_next/static/ — to
# 127.0.0.1:3000, because the `nginx` user is not in `code-agents` and cannot
# read the locked-down build tree. So the Node process is the only thing that
# serves assets, and restarting it is the entire deploy. (A filesystem alias
# in nginx is not viable here for that permission reason.)
#
# User model on this host: "zeh builds, PM runtime user runs."
#   - zeh      owns the checkout + node_modules, is in `code-agents`, can
#              build, has passwordless sudo — but cannot read .env.local.
#   - APP_USER owns the running server secrets.
# So this script BUILDS as the caller (must own node_modules) and uses
# `sudo -u karen` only for the env-seed + restart fallback.
#
# Usage
# -----
#   ai/web/deploy/rebuild-and-restart.sh
#
# Run it as the build user (zeh). It needs passwordless sudo to APP_USER.
# Override any setting via the environment, e.g. PORT=3000 PM_APP_DIR=... .

set -euo pipefail

# ---- configuration (override via environment) -----------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
APP_USER="${PM_APP_USER:-karen}"      # account that owns the server + secrets
APP_DIR="${PM_APP_DIR:-${PM_APP_ROOT:-$DEFAULT_APP_DIR}}"
PNPM="${PM_PNPM:-/usr/local/bin/pnpm}"
NODE_BIN="${PM_NODE_BIN:-/usr/bin/node24}"
PORT="${PORT:-3000}"
HOST="${PM_HOST:-127.0.0.1}"          # bind loopback only; nginx fronts it
ENV_FILE="${PM_ENV_FILE:-$APP_DIR/.env.local}"
LOG_FILE="${PM_LOG_FILE:-$APP_DIR/.next/pm-server.log}"
ATTACHMENT_ROOT="${PM_ATTACHMENT_ROOT:-/srv/Data/projects}"

STANDALONE="$APP_DIR/.next/standalone"

log() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
as_app() { sudo -n -u "$APP_USER" "$@"; }
set_acl() {
  setfacl "$@" 2>/dev/null || sudo -n setfacl "$@" 2>/dev/null || true
}

grant_runtime_access() {
  command -v setfacl >/dev/null 2>&1 || return 0
  local acl_path="$APP_DIR"
  while [[ "$acl_path" != "/" && -n "$acl_path" ]]; do
    set_acl -m "u:$APP_USER:x" "$acl_path"
    acl_path="$(dirname "$acl_path")"
  done
  if [[ -d "$STANDALONE" ]]; then
    mkdir -p "$STANDALONE/.next/cache/fetch-cache"
    set_acl -R -m "u:$APP_USER:rx" "$STANDALONE"
    set_acl -m "u:$APP_USER:rwx" "$STANDALONE" "$STANDALONE/.next" "$STANDALONE/.next/cache" "$STANDALONE/.next/cache/fetch-cache"
    set_acl -dR -m "u:$APP_USER:rwx" "$STANDALONE/.next/cache"
  fi
  if [[ -d "$APP_DIR/prisma" ]]; then
    set_acl -R -m "u:$APP_USER:rwx" "$APP_DIR/prisma"
    set_acl -dR -m "u:$APP_USER:rwx" "$APP_DIR/prisma"
  fi
  if [[ -d "$APP_DIR/.data" ]]; then
    set_acl -R -m "u:$APP_USER:rwx" "$APP_DIR/.data"
    set_acl -dR -m "u:$APP_USER:rwx" "$APP_DIR/.data"
  fi
  if [[ -d "$ATTACHMENT_ROOT" ]]; then
    acl_path="$ATTACHMENT_ROOT"
    while [[ "$acl_path" != "/" && -n "$acl_path" ]]; do
      set_acl -m "u:$APP_USER:x" "$acl_path"
      acl_path="$(dirname "$acl_path")"
    done
    set_acl -R -m "u:$APP_USER:rwx" "$ATTACHMENT_ROOT"
    set_acl -dR -m "u:$APP_USER:rwx" "$ATTACHMENT_ROOT"
  fi
}

# ---- preflight ------------------------------------------------------------
[[ -x "$PNPM" ]]     || die "pnpm not found/executable at $PNPM (set PM_PNPM)."
[[ -x "$NODE_BIN" ]] || die "node not found/executable at $NODE_BIN (set PM_NODE_BIN)."
[[ -d "$APP_DIR" ]]  || die "app dir not found: $APP_DIR (set PM_APP_DIR)."
sudo -n -u "$APP_USER" true 2>/dev/null \
  || die "need passwordless sudo to '$APP_USER' (env-seed + restart run as that user)."

# ---- 1. build (as the caller — owns node_modules) -------------------------
log "Building standalone bundle in $APP_DIR (this wipes .next)…"
cd "$APP_DIR"
"$PNPM" build
[[ -f "$STANDALONE/server.js" ]] || die "build did not produce $STANDALONE/server.js"
grant_runtime_access

# ---- 2. seed runtime env into the standalone dir (as APP_USER) ------------
# The standalone server loads .env* from its own cwd via @next/env, but the
# build just wiped .next/standalone. Re-seed the canonical env file (readable
# only by APP_USER) so the new process has DATABASE_URL / AUTH_SECRET / etc.
if as_app test -f "$ENV_FILE"; then
  log "Seeding env: $ENV_FILE -> $STANDALONE/.env.local"
  as_app install -m 0600 "$ENV_FILE" "$STANDALONE/.env.local"
else
  printf '\033[1;33mWARN:\033[0m %s not found — relying on inherited env.\n' "$ENV_FILE"
fi

# ---- 3. apply database migrations -----------------------------------------
if as_app test -f "$ENV_FILE"; then
  log "Applying Prisma migrations as $APP_USER…"
  as_app bash -lc "cd '$APP_DIR' && set -a && . '$ENV_FILE' && set +a && '$PNPM' prisma migrate deploy"
else
  printf '\033[1;33mWARN:\033[0m %s not found — skipping Prisma migrate deploy.\n' "$ENV_FILE"
fi

# ---- 4. restart the server ------------------------------------------------
if systemctl list-unit-files 'pm.service' --no-legend 2>/dev/null | grep -q '^pm\.service'; then
  log "Restarting pm.service through systemd…"
  sudo -n systemctl restart pm.service
else
  # Fallback for pre-systemd installs. The process title is rewritten to
  # "next-server", so the port is the only reliable handle.
  log "pm.service is not installed; stopping any server on :$PORT…"
  as_app fuser -k "${PORT}/tcp" 2>/dev/null || true
  for _ in $(seq 1 20); do
    ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q ":$PORT" || break
    sleep 0.5
  done

  log "Starting new server on $HOST:$PORT (logging to $LOG_FILE)…"
  as_app bash -c "cd '$STANDALONE' && PORT='$PORT' HOSTNAME='$HOST' \
    setsid nohup '$NODE_BIN' server.js >>'$LOG_FILE' 2>&1 </dev/null & disown"
fi

# ---- 5. verify ------------------------------------------------------------
log "Waiting for the server to listen…"
ok=""
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://$HOST:$PORT/login" 2>/dev/null; then ok=1; break; fi
  sleep 0.5
done
[[ -n "$ok" ]] || die "server did not come up on $HOST:$PORT — see $LOG_FILE"

# Confirm the served HTML references a CSS file that actually serves 200.
ref="$(curl -fsS "http://$HOST:$PORT/login" | grep -oE '/_next/static/css/[a-f0-9]+\.css' | head -1 || true)"
if [[ -n "$ref" ]]; then
  code="$(curl -fsS -o /dev/null -w '%{http_code}' "http://$HOST:$PORT$ref" 2>/dev/null || echo 000)"
  [[ "$code" == "200" ]] \
    && log "OK — live HTML references $ref and it serves 200. Hard-refresh the site." \
    || die "asset mismatch: HTML references $ref but it returns HTTP $code"
else
  log "OK — server is up (could not sample a CSS ref, but /login responded)."
fi
