#!/usr/bin/env bash
#
# worktree-preview-install.sh — ENV-107 supervised installer.
#
# Wires the generic, registry-driven worktree live-preview switcher into the
# host for WDT (node-service) and Patricia (nginx-docroot). Run by Zeh with
# sudo during the supervised window:
#
#     sudo ~/worktree-preview-install.sh            # = all (wdt + patricia)
#     sudo ~/worktree-preview-install.sh wdt        # just WDT
#     sudo ~/worktree-preview-install.sh patricia   # just Patricia
#     sudo ~/worktree-preview-install.sh status     # show what's installed/active
#     sudo ~/worktree-preview-install.sh migrate-pm # PRODUCTION PM — staged, gated
#
# Idempotent: re-running is safe (env files are regenerated, the DB seed and
# Patricia symlink are only created if missing, systemctl enable is a no-op when
# already enabled). PM production is NOT touched by `all`; it has its own gated
# subcommand and keeps its existing pm-switch* mechanism until cutover.
#
# It installs the privileged helpers committed on branch ENV-107-worktree-switch
# (reviewable by asdrubal); nothing here is bespoke per project beyond the two
# /etc/worktree-preview/<key>.env contracts.
set -euo pipefail

# ---- knobs (override on the command line: VAR=... sudo -E ...) -------------
SRC="${SRC:-$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)}"
WT_MONITOR_USER="${WT_MONITOR_USER:-barekbaal}"   # runs the switch runner + sudo apply
PM_WEB_USER="${PM_WEB_USER:-karen}"               # PM web app reads/writes each spool
CODE_GROUP="${CODE_GROUP:-code-agents}"
SBIN=/usr/local/sbin
ENVDIR=/etc/worktree-preview
UNITDIR=/etc/systemd/system
LOCKDIR=/var/lib/worktree-locks

c_info=$'\033[1;36m'; c_ok=$'\033[1;32m'; c_warn=$'\033[1;33m'; c_err=$'\033[1;31m'; c_z=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$c_info" "$c_z" "$*"; }
ok()   { printf '%s ok %s %s\n' "$c_ok" "$c_z" "$*"; }
warn() { printf '%sWARN%s %s\n' "$c_warn" "$c_z" "$*" >&2; }
die()  { printf '%sERR %s %s\n' "$c_err" "$c_z" "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "must run as root: sudo $0 ${*:-all}"
[[ -d "$SRC" ]]   || die "source deploy dir not found: $SRC (set SRC=...)"
id "$WT_MONITOR_USER" >/dev/null 2>&1 || die "monitor user '$WT_MONITOR_USER' does not exist (set WT_MONITOR_USER=...)"
id "$PM_WEB_USER" >/dev/null 2>&1 || die "PM web user '$PM_WEB_USER' does not exist (set PM_WEB_USER=...)"
command -v setfacl >/dev/null 2>&1 || die "setfacl is required to grant the PM web app spool access"

# ---------------------------------------------------------------------------
# shared: helpers, systemd templates, sudoers, env dir
# ---------------------------------------------------------------------------
install_shared() {
  log "Installing privileged helpers to $SBIN …"
  install -m 0755 -o root -g root "$SRC/worktree-switch.sh"        "$SBIN/worktree-switch"
  install -m 0755 -o root -g root "$SRC/worktree-switch-runner"    "$SBIN/worktree-switch-runner"
  install -m 0755 -o root -g root "$SRC/worktree-remove"           "$SBIN/worktree-remove"
  install -m 0755 -o root -g root "$SRC/worktree-preview-serve"    "$SBIN/worktree-preview-serve"
  install -m 0755 -o root -g root "$SRC/worktree-preview-apply"    "$SBIN/worktree-preview-apply"
  install -m 0755 -o root -g root "$SRC/worktree-docroot-apply"    "$SBIN/worktree-docroot-apply"
  ok "helpers installed"

  log "Installing systemd templates (monitor user: $WT_MONITOR_USER) …"
  install -m 0644 -o root -g root "$SRC/systemd/worktree-preview@.service" "$UNITDIR/worktree-preview@.service"
  sed "s/__WT_MONITOR_USER__/$WT_MONITOR_USER/g" "$SRC/systemd/worktree-switch-runner@.service" \
    > "$UNITDIR/worktree-switch-runner@.service"
  chmod 0644 "$UNITDIR/worktree-switch-runner@.service"
  ok "units installed"

  log "Installing sudoers grant (validated with visudo -c) …"
  local tmp; tmp="$(mktemp)"
  sed "s/__WT_MONITOR_USER__/$WT_MONITOR_USER/g" "$SRC/sudoers.d/worktree-preview" > "$tmp"
  visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; die "sudoers validation FAILED — not installed"; }
  install -m 0440 -o root -g root "$tmp" /etc/sudoers.d/worktree-preview
  rm -f "$tmp"
  ok "/etc/sudoers.d/worktree-preview installed"

  install -d -m 0755 -o root -g root "$ENVDIR"
  install -d -m 0750 -o root -g "$CODE_GROUP" "$LOCKDIR"

  # The PM web app hosts the switcher UI for ALL registered projects, but
  # pm.service runs ProtectSystem=strict — without an explicit grant its spool
  # writes to /var/lib/worktree-switch/<key> fail with EROFS and the Settings
  # panel shows "Failed to request switch" for wdt/patricia. The 60- prefix
  # sorts after the 20-active-worktree.conf reset that pm-apply-worktree
  # rewrites on every PM switch, so the grant survives switches.
  if systemctl list-unit-files 'pm.service' --no-legend 2>/dev/null | grep -q '^pm\.service'; then
    local dropin_dir=/etc/systemd/system/pm.service.d
    local dropin=$dropin_dir/60-worktree-switch-spools.conf
    local tmp_dropin; tmp_dropin="$(mktemp)"
    printf '[Service]\nReadWritePaths=-/var/lib/worktree-switch\n' > "$tmp_dropin"
    if ! cmp -s "$tmp_dropin" "$dropin" 2>/dev/null; then
      install -d "$dropin_dir"
      install -m 0644 -o root -g root "$tmp_dropin" "$dropin"
      systemctl daemon-reload
      systemctl try-restart pm.service \
        || warn "could not restart pm.service — restart it manually so the spool grant takes effect"
      ok "$dropin installed (pm.service restarted for the sandbox grant)"
    else
      ok "$dropin already current"
    fi
    rm -f "$tmp_dropin"
  else
    warn "pm.service not installed — skipped the PM spool grant (browser-triggered switches need it once PM exists)"
  fi

  systemctl daemon-reload
}

# Operation locks coordinate the long-running runner, direct CLI switches, and
# local cleanup. Preserve an existing lock's inode on reconcile: replacing a
# file that another process has flocked would briefly create two independent
# locks for the same project.
ensure_operation_lock() {
  local lock_file="$1"
  if [[ -L "$lock_file" || ( -e "$lock_file" && ! -f "$lock_file" ) ]]; then
    die "refusing unsafe worktree operation lock: $lock_file"
  fi
  if [[ ! -e "$lock_file" ]]; then
    install -o root -g "$CODE_GROUP" -m 0660 /dev/null "$lock_file"
    ok "created worktree operation lock $lock_file"
  else
    chown root:"$CODE_GROUP" "$lock_file"
    chmod 0660 "$lock_file"
    ok "preserved worktree operation lock $lock_file"
  fi
}

# Keep these descriptors open while shared executables and project contracts
# are being replaced. A direct CLI switch/remove takes the same flock, so this
# waits for any operation that was already in flight and prevents a new one
# from observing a mixed old/new helper set.
declare -A HELD_OPERATION_LOCK_FDS=()

acquire_operation_lock() {
  local key="$1" lock_file="$LOCKDIR/$1.lock" fd
  ensure_operation_lock "$lock_file"
  exec {fd}<>"$lock_file"
  if ! flock -w 30 "$fd"; then
    exec {fd}>&-
    die "timed out waiting for the $key worktree operation lock; retry after the active switch/remove finishes"
  fi
  HELD_OPERATION_LOCK_FDS["$key"]="$fd"
  ok "holding $key worktree operation lock during reconciliation"
}

release_operation_lock() {
  local key="$1" fd="${HELD_OPERATION_LOCK_FDS[$1]-}"
  [[ -n "$fd" ]] || return 0
  exec {fd}>&-
  unset 'HELD_OPERATION_LOCK_FDS[$key]'
}

release_all_operation_locks() {
  local key
  for key in "${!HELD_OPERATION_LOCK_FDS[@]}"; do
    release_operation_lock "$key"
  done
}

# Replace contracts atomically so a CLI switch cannot source a half-written
# file while this installer is reconciling a legacy installation.
write_contract() {
  local key="$1" target="$ENVDIR/$1.env" tmp
  tmp="$(mktemp "$ENVDIR/.$key.env.XXXXXX")"
  if ! cat > "$tmp"; then
    rm -f "$tmp"
    die "could not render $target"
  fi
  chown root:root "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$target"
}

verify_operation_contract() {
  local key="$1" expected_lock="$2" env_file="$ENVDIR/$1.env"
  [[ -r "$env_file" ]] || die "missing project contract after install: $env_file"
  [[ "$(grep -c '^WORKTREE_LOCK_FILE=' "$env_file" || true)" == 1 ]] \
    || die "$env_file must declare WORKTREE_LOCK_FILE exactly once"
  grep -Fqx "WORKTREE_LOCK_FILE=$expected_lock" "$env_file" \
    || die "$env_file does not reference the expected lock $expected_lock"
  [[ -f "$expected_lock" && ! -L "$expected_lock" ]] \
    || die "worktree operation lock is missing or unsafe: $expected_lock"
}

# A pre-removal runner does not understand action=remove and treats it as a
# switch. Stop that long-running process before replacing helpers or repairing
# its contract, closing the upgrade window in which a cleanup request could be
# interpreted by stale code. The project installer starts it again at the end.
QUIESCED_RUNNERS=()

restore_quiesced_runners() {
  local status=$? key unit
  trap - EXIT
  release_all_operation_locks
  for key in "${QUIESCED_RUNNERS[@]}"; do
    unit="worktree-switch-runner@$key.service"
    if ! systemctl is-active --quiet "$unit"; then
      if (( status == 0 )); then
        log "Reloading $unit after shared-helper reconciliation …"
      else
        warn "installer exited before $key reconciliation completed; restoring $unit"
      fi
      systemctl start "$unit" || warn "could not restore $unit — start it manually after fixing the installer error"
    fi
  done
  exit "$status"
}

trap restore_quiesced_runners EXIT

quiesce_runner() {
  local key="$1" unit="worktree-switch-runner@$1.service"
  if systemctl is-active --quiet "$unit"; then
    log "Stopping $unit during contract reconciliation …"
    # Record it before stop: systemctl can report failure after the unit has
    # already transitioned down, and the EXIT handler must still restore it.
    QUIESCED_RUNNERS+=("$key")
    systemctl stop "$unit"
  fi
}

# install_shared replaces executables used by every generic runner. Stop all
# currently supported consumers before that replacement, even for a
# target-specific contract repair, so no other project keeps an old in-memory
# runner paired with newly installed helpers.
quiesce_shared_runners() {
  quiesce_runner wdt
  quiesce_runner patricia
  install -d -m 0750 -o root -g "$CODE_GROUP" "$LOCKDIR"
  acquire_operation_lock wdt
  acquire_operation_lock patricia
}

# ---------------------------------------------------------------------------
# WDT — node-service (Next.js + per-branch SQLite forked from wdt.main)
# ---------------------------------------------------------------------------
install_wdt() {
  local key=wdt
  local repo=/srv/Code/whitsunday-discovery-trail
  local wtroot=/srv/Code/whitsunday-discovery-trail.worktrees
  local spool=/var/lib/worktree-switch/$key
  local db_root=/srv/Data/wdt
  local canonical=$db_root/wdt.main.db
  local seed_src=$db_root/data/prisma/production.db   # existing live data
  local lock_file=$LOCKDIR/$key.lock

  [[ -d "$repo" ]]   || die "WDT repo missing: $repo"
  [[ -d "$wtroot" ]] || die "WDT worktrees root missing: $wtroot"
  ensure_operation_lock "$lock_file"

  log "Writing $ENVDIR/$key.env …"
  write_contract "$key" <<EOF
# WDT — node-service worktree-preview contract (generated by worktree-preview-install.sh)
KEY=$key
DRIVER=node-service
REPO=$repo
WORKTREES_ROOT=$wtroot
SPOOL_DIR=$spool
WORKTREE_LOCK_FILE=$lock_file
APP_SUBDIR=
SERVED_UNIT=worktree-preview@$key.service
PORT=3001
HOST=127.0.0.1
BUILD_CMD='pnpm build'
START_CMD='pnpm start'
# WDT's next.config.js sets distDir: 'dist', so the build output is dist/ not
# .next/. Default is .next when omitted (e.g. PM). Used by worktree-switch.sh
# and worktree-preview-apply to locate/validate the build.
BUILD_OUTPUT_DIR=dist
MIGRATE_CMD='pnpm exec prisma migrate deploy'
DB_ENGINE=sqlite
CANONICAL_DB=$canonical
DB_ROOT=$db_root
EOF
  verify_operation_contract "$key" "$lock_file"
  ok "$ENVDIR/$key.env"

  log "Creating private spool dir $spool (runner + PM web ACL) …"
  install -d -m 2700 -o "$WT_MONITOR_USER" -g root "$spool"
  setfacl -b "$spool"
  if [[ "$PM_WEB_USER" != "$WT_MONITOR_USER" ]]; then
    setfacl -m "u:$PM_WEB_USER:rwx,d:u:$PM_WEB_USER:rwx,d:u:$WT_MONITOR_USER:rwx" "$spool"
  fi

  # DB_ROOT must be group-writable so the runner can create per-branch forks.
  log "Ensuring $db_root is writable by $CODE_GROUP (per-branch DB forks) …"
  chgrp "$CODE_GROUP" "$db_root" || warn "could not chgrp $db_root"
  chmod 2775 "$db_root" || warn "could not chmod $db_root"

  log "Seeding canonical $canonical (the wdt.main all branch DBs fork from) …"
  if [[ -f "$canonical" ]]; then
    ok "canonical already present: $canonical (left untouched)"
  elif [[ -f "$seed_src" ]]; then
    cp -a "$seed_src" "$canonical"
    chgrp "$CODE_GROUP" "$canonical"; chmod 0664 "$canonical"
    ok "seeded $canonical from $seed_src"
  else
    warn "no seed source at $seed_src — create $canonical (wdt.main) before first switch"
  fi

  log "Enabling served unit + switch runner for $key …"
  release_operation_lock "$key"
  systemctl daemon-reload
  systemctl enable "worktree-preview@$key.service" >/dev/null || warn "could not enable served unit (it will still be started by the first successful switch)"
  systemctl enable --now "worktree-switch-runner@$key.service"
  systemctl restart "worktree-switch-runner@$key.service"
  ok "WDT runner active. Configure the deployment reverse proxy for its service port."
  warn "First switch builds the worktree before the served unit can come up; pick a worktree in the PM/WDT switch UI (or: sudo -u $WT_MONITOR_USER worktree-switch $key <branch>)."
}

# ---------------------------------------------------------------------------
# Patricia — nginx-docroot (PHP/Joomla, shared MySQL, no per-branch DB)
# ---------------------------------------------------------------------------
install_patricia() {
  local key=patricia
  local repo=/srv/Code/patricia
  local wtroot=/srv/Code/patricia.worktrees
  local spool=/var/lib/worktree-switch/$key
  local link=/srv/Code/patricia.current
  local lock_file=$LOCKDIR/$key.lock

  [[ -d "$repo" ]]   || die "Patricia repo missing: $repo"
  [[ -d "$wtroot" ]] || die "Patricia worktrees root missing: $wtroot"
  ensure_operation_lock "$lock_file"

  log "Writing $ENVDIR/$key.env …"
  write_contract "$key" <<EOF
# Patricia — nginx-docroot worktree-preview contract (generated by worktree-preview-install.sh)
KEY=$key
DRIVER=nginx-docroot
REPO=$repo
WORKTREES_ROOT=$wtroot
SPOOL_DIR=$spool
WORKTREE_LOCK_FILE=$lock_file
APP_SUBDIR=
# nginx document root; repointed per switch and removed when the site is off.
CURRENT_SYMLINK=$link
RELOAD_CMD='nginx -s reload'
# off = project COMPLETELY off (symlink removed). To serve a maintenance page
# instead, set MAINTENANCE_ROOT=/srv/www/maintenance and 'off' points there.
# MAINTENANCE_ROOT=
DB_ENGINE=none
OFF_MODE=off
EOF
  verify_operation_contract "$key" "$lock_file"
  ok "$ENVDIR/$key.env"

  log "Creating private spool dir $spool (runner + PM web ACL) …"
  install -d -m 2700 -o "$WT_MONITOR_USER" -g root "$spool"
  setfacl -b "$spool"
  if [[ "$PM_WEB_USER" != "$WT_MONITOR_USER" ]]; then
    setfacl -m "u:$PM_WEB_USER:rwx,d:u:$PM_WEB_USER:rwx,d:u:$WT_MONITOR_USER:rwx" "$spool"
  fi

  if [[ -L "$link" ]]; then
    ok "docroot symlink already present: $link -> $(readlink "$link")"
  else
    warn "no docroot symlink at $link yet — Patricia is OFF until the first switch repoints it."
  fi

  log "Enabling switch runner for $key (no served unit; nginx-docroot has no per-project process) …"
  release_operation_lock "$key"
  systemctl daemon-reload
  systemctl enable --now "worktree-switch-runner@$key.service"
  systemctl restart "worktree-switch-runner@$key.service"
  ok "Patricia runner active. Switch in the UI (or: sudo -u $WT_MONITOR_USER worktree-switch $key <branch>)."
}

# ---------------------------------------------------------------------------
# PM (environment) — PRODUCTION. Staged + gated; NOT run by `all`.
# ---------------------------------------------------------------------------
migrate_pm() {
  local key=environment
  warn "PM is the PRODUCTION environment. This subcommand only STAGES the new"
  warn "contract; it does NOT disturb the running pm.service / pm-switch* setup."
  ensure_operation_lock "$LOCKDIR/$key.lock"
  log "Staging $ENVDIR/$key.env (the generic contract mirroring the PM mechanism) …"
  write_contract "$key" <<'EOF'
# PM / environment — node-service contract (STAGED for the supervised cutover).
# PM keeps its existing pm-switch*/pm-apply-worktree mechanism until cutover is
# explicitly performed. Do NOT enable worktree-preview@environment until then.
KEY=environment
DRIVER=node-service
REPO=/srv/Code/environment
WORKTREES_ROOT=/srv/Code/environment.worktrees
SPOOL_DIR=/var/lib/pm/switch
WORKTREE_LOCK_FILE=/var/lib/worktree-locks/environment.lock
APP_SUBDIR=ai/web
SERVED_UNIT=pm.service
PORT=3000
HOST=127.0.0.1
BUILD_CMD='pnpm build'
START_CMD='node ai/web/.next/standalone/server.js'
MIGRATE_CMD='pnpm exec prisma migrate deploy'
DB_ENGINE=sqlite
CANONICAL_DB=/srv/Data/pm/pm.db
DB_ROOT=/srv/Data/pm
EOF
  verify_operation_contract "$key" "$LOCKDIR/$key.lock"
  ok "staged $ENVDIR/$key.env"
  cat <<EOF

${c_warn}PM cutover is a manual, supervised step — NOT performed here.${c_z}
When you are ready to move PM onto the generic runner:
  1. Stop the legacy runner:    systemctl disable --now pm-switch-runner.service
  2. Reconcile the served unit: PM serves the Next standalone via pm.service;
     the generic worktree-preview-apply writes a WorkingDirectory drop-in to a
     'worktree-preview@environment' unit, so cutover means either pointing the
     generic apply at pm.service's drop-in or switching to the templated unit.
     Decide WITH Zeh before flipping — this is the production site.
  3. Enable generic runner:     systemctl enable --now worktree-switch-runner@environment
Until step 1-3 are done, PM keeps running exactly as today.
EOF
}

show_status() {
  local failures=0
  log "Installed helpers:";   ls -l "$SBIN"/worktree-switch "$SBIN"/worktree-switch-runner "$SBIN"/worktree-remove "$SBIN"/worktree-preview-serve "$SBIN"/worktree-preview-apply "$SBIN"/worktree-docroot-apply 2>/dev/null || true
  log "Env contracts:";       ls -l "$ENVDIR"/ 2>/dev/null || true
  log "Sudoers:";             ls -l /etc/sudoers.d/worktree-preview 2>/dev/null || true
  log "Units:";               systemctl --no-legend list-unit-files 'worktree-preview@*' 'worktree-switch-runner@*' 2>/dev/null || true
  for k in wdt patricia; do
    local env_file="$ENVDIR/$k.env" expected_lock="$LOCKDIR/$k.lock" configured_lock=""
    if [[ -r "$env_file" ]]; then
      configured_lock="$(sed -n 's/^WORKTREE_LOCK_FILE=//p' "$env_file")"
    fi
    if [[ "$configured_lock" != "$expected_lock" ]]; then
      warn "$k contract is incomplete: expected WORKTREE_LOCK_FILE=$expected_lock in $env_file"
      warn "repair with: $0 $k"
      failures=1
    elif [[ ! -f "$expected_lock" || -L "$expected_lock" ]]; then
      warn "$k operation lock is missing or unsafe: $expected_lock"
      warn "repair with: $0 $k"
      failures=1
    else
      printf '  contract %-8s ok (%s)\n' "$k" "$expected_lock"
    fi

    if systemctl is-enabled "worktree-switch-runner@$k.service" >/dev/null 2>&1; then
      local active pid elapsed started latest helper mtime
      active="$(systemctl is-active "worktree-switch-runner@$k.service" 2>/dev/null || true)"
      printf '  runner %-10s %s\n' "$k" "$active"
      if [[ "$active" == active ]]; then
        pid="$(systemctl show -p MainPID --value "worktree-switch-runner@$k.service" 2>/dev/null || true)"
        elapsed="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
        latest=0
        for helper in "$SBIN/worktree-switch-runner" "$SBIN/worktree-switch" "$SBIN/worktree-remove"; do
          mtime="$(stat -c %Y "$helper" 2>/dev/null || echo 0)"
          (( mtime > latest )) && latest=$mtime
        done
        if [[ "$elapsed" =~ ^[0-9]+$ ]]; then
          started=$(( $(date +%s) - elapsed ))
          if (( latest > started )); then
            warn "$k runner predates an installed helper and has not loaded it; repair with: $0 $k"
            failures=1
          fi
        fi
      fi
    fi
  done
  return "$failures"
}

case "${1:-all}" in
  all)        quiesce_shared_runners; install_shared; install_wdt; install_patricia
              log "Done. PM production untouched (use 'migrate-pm' for that, supervised)." ;;
  wdt)        quiesce_shared_runners; install_shared; install_wdt ;;
  patricia)   quiesce_shared_runners; install_shared; install_patricia ;;
  migrate-pm) quiesce_shared_runners; install_shared; migrate_pm ;;
  status)     show_status ;;
  *) die "usage: $0 [all|wdt|patricia|migrate-pm|status]" ;;
esac
