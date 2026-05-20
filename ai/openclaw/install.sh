#!/bin/bash
# install.sh — deploy OpenClaw host-level scripts + systemd units.
#
# Idempotent: re-running with no source changes is a no-op modulo a few
# stat/md5 checks. Designed to be run after every `git pull` in this
# repo working tree, or on a fresh host as part of bootstrap.
#
# What it does:
#   1. install bin/ scripts to /usr/local/bin and /usr/local/sbin
#   2. install systemd/ system units to /etc/systemd/system
#   3. install systemd/user/ user units to /etc/systemd/user (admin-installed
#      user units, visible to every user's systemd instance — only the
#      monitor agent enables them based on derived services)
#   4. generate openclaw-monitor-sync.path from agents.json (host-specific:
#      systemd Path units don't support globs, so one PathChanged= per agent)
#   5. symlink the frontend HTML for agent-dashboard
#   6. systemctl daemon-reload (system + per-user) + restart running units
#   7. reconcile per-agent user-systemd state against the derived services
#      list — enable+start what should run, stop+disable orphans (e.g. the
#      legacy openclaw-webhook-receiver after its split into jira+bitbucket
#      receivers)
#
# What it does NOT do:
#   - install sudoers files (must be reviewed + substituted by hand)
#   - install /etc/agent-dashboard/config.json (host-specific, copy
#     config/agent-dashboard.config.json.example as a starting point)
#   - install /etc/openclaw/agents.json (host-specific identity file)
#
# Run as root:  sudo ./install.sh
# Dry run:      ./install.sh --dry-run

set -u
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="${OPENCLAW_AGENTS_JSON:-/etc/openclaw/agents.json}"
DEFAULTS="${OPENCLAW_AGENT_DEFAULTS:-/etc/openclaw/agent-defaults.json}"

if [ -t 1 ]; then
    C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_DIM=$'\e[2m'; C_RST=$'\e[0m'
else
    C_OK=''; C_WARN=''; C_DIM=''; C_RST=''
fi
log() { printf '%s%s%s\n' "${C_DIM}" "$*" "${C_RST}"; }
ok()  { printf '%s✓%s %s\n' "${C_OK}" "${C_RST}" "$*"; }
warn(){ printf '%s!%s %s\n' "${C_WARN}" "${C_RST}" "$*"; }

if [ "$EUID" -ne 0 ] && [ "$DRY" -eq 0 ]; then
    warn "must run as root (use --dry-run to preview)"
    exit 1
fi

do_install() {
    local mode="$1" src="$2" dst="$3"
    if [ ! -e "$src" ]; then
        warn "missing source $src — skipping"
        return
    fi
    if [ "$DRY" -eq 1 ]; then
        log "  would install -m $mode $src → $dst"
        return
    fi
    install -o root -g root -m "$mode" "$src" "$dst"
    ok "$dst"
}

# 1. bin scripts
log "[1/7] bin scripts"
do_install 755 "$REPO_ROOT/bin/ai-monitor"                /usr/local/bin/ai-monitor
do_install 755 "$REPO_ROOT/bin/openclaw-integrity-check"  /usr/local/bin/openclaw-integrity-check
do_install 755 "$REPO_ROOT/bin/openclaw-control"          /usr/local/sbin/openclaw-control
do_install 755 "$REPO_ROOT/bin/agent-dashboard"           /usr/local/bin/agent-dashboard
do_install 755 "$REPO_ROOT/bin/openclaw-monitor-sync"     /usr/local/sbin/openclaw-monitor-sync
do_install 755 "$REPO_ROOT/bin/openclaw-typing-keepalive" /usr/local/bin/openclaw-typing-keepalive
do_install 755 "$REPO_ROOT/bin/gmail-watch-renew-all"     /usr/local/sbin/gmail-watch-renew-all

# 2. system-wide systemd units (host-portable)
log "[2/7] systemd system units"
for u in agent-dashboard.service \
         openclaw-monitor-sync.service openclaw-monitor-sync.timer \
         openclaw-typing-keepalive.service \
         gmail-watch-renew.service gmail-watch-renew.timer; do
    do_install 644 "$REPO_ROOT/systemd/$u" "/etc/systemd/system/$u"
done

# 3. systemd USER units (per-agent, but installed system-wide at
# /etc/systemd/user/ so every user's systemd instance can see them. The
# monitor agent enables the openclaw-{jira,bitbucket}-receiver pair via
# step 7's reconcile; other agents leave them disabled.
log "[3/7] systemd user units (admin-installed, system-wide visible)"
if [ -d "$REPO_ROOT/systemd/user" ]; then
    if [ "$DRY" -eq 0 ]; then
        mkdir -p /etc/systemd/user
    fi
    for src in "$REPO_ROOT"/systemd/user/*.service; do
        [ -e "$src" ] || continue
        do_install 644 "$src" "/etc/systemd/user/$(basename "$src")"
    done
fi

# 4. generate openclaw-monitor-sync.path
log "[4/7] generate openclaw-monitor-sync.path from $REGISTRY"
if [ ! -r "$REGISTRY" ]; then
    warn "  $REGISTRY not readable; skipping .path generation"
else
    PATH_LINES=""
    while IFS=$'\t' read -r user home; do
        [ -z "$user" ] && continue
        mpath="${home:-/home/$user}/.local/openclaw/monitor.json"
        PATH_LINES+=$'PathChanged='"$mpath"$'\n'
    done < <(jq -r '.agents[] | select(.enabled == true) | "\(.user)\t\(.home // "")"' "$REGISTRY")

    TMP=$(mktemp)
    awk -v lines="$PATH_LINES" '/@PATH_CHANGED_LINES@/{printf "%s", lines; next} {print}' \
        "$REPO_ROOT/systemd/openclaw-monitor-sync.path.in" > "$TMP"
    if [ "$DRY" -eq 1 ]; then
        log "  would install $TMP → /etc/systemd/system/openclaw-monitor-sync.path"
    else
        install -o root -g root -m 644 "$TMP" /etc/systemd/system/openclaw-monitor-sync.path
        ok "/etc/systemd/system/openclaw-monitor-sync.path"
    fi
    rm -f "$TMP"
fi

# 4b. webhook receiver scripts → monitor agent's ~/webhooks/
# common.js + jira-receiver.js + bitbucket-receiver.js are shared logic
# loaded by the user-units (openclaw-{jira,bitbucket}-receiver.service).
# The monitor agent runs them; coding agents don't need the scripts at
# all. Discovered from the registry (role=monitor); no hardcoding.
log "[4b/7] webhook scripts → monitor agent home"
if [ -d "$REPO_ROOT/webhooks" ] && [ -r "$REGISTRY" ] && command -v jq >/dev/null 2>&1; then
    MONITOR_LINE=$(jq -r '.agents[] | select(.role == "monitor" and .enabled == true) | "\(.user)\t\(.home // "/home/\(.user)")"' "$REGISTRY" | head -1)
    if [ -n "$MONITOR_LINE" ]; then
        m_user=$(echo "$MONITOR_LINE" | cut -f1)
        m_home=$(echo "$MONITOR_LINE" | cut -f2)
        dst="$m_home/webhooks"
        if [ "$DRY" -eq 1 ]; then
            log "  would install webhooks/*.js → $dst/ (owner=$m_user)"
        else
            for src in "$REPO_ROOT"/webhooks/*.js; do
                [ -e "$src" ] || continue
                mode=755; [ "$(basename "$src")" = "common.js" ] && mode=644
                install -o "$m_user" -g "$m_user" -m "$mode" "$src" "$dst/$(basename "$src")"
                ok "$dst/$(basename "$src")"
            done
        fi
    else
        warn "  no monitor agent in registry — skipping webhook scripts"
    fi
fi

# 4c. agent-self.js symlink → every agent's ~/.openclaw/skills/agent-self.js
# Sender helpers (gmail-send.js, local-mail/maildir.js) require('../agent-self').
# Agents invoke skill scripts via the symlinked ~/.openclaw/skills/<skill>/
# tree with --preserve-symlinks (so per-agent node_modules resolves). That
# resolution treats ../ relative to the symlink location — without an
# agent-self symlink in the agent's own skills/ dir, the require fails.
# Symlinking points back to the canonical repo copy so updates propagate.
log "[4c/7] agent-self.js symlinks per agent"
if [ -r "$REGISTRY" ] && command -v jq >/dev/null 2>&1; then
    while IFS=$'\t' read -r user home; do
        [ -z "$user" ] && continue
        dst="${home:-/home/$user}/.openclaw/skills/agent-self.js"
        src="$REPO_ROOT/skills/agent-self.js"
        if [ "$DRY" -eq 1 ]; then
            log "  would symlink $dst → $src"
            continue
        fi
        # Mkdir as the agent (avoid root-owned skills dir).
        sudo -u "$user" mkdir -p "$(dirname "$dst")" 2>/dev/null
        sudo -u "$user" ln -snf "$src" "$dst" 2>/dev/null && ok "$dst"
    done < <(jq -r '.agents[] | select(.enabled == true) | "\(.user)\t\(.home // "")"' "$REGISTRY")
fi

# 4d. codeRoot drift check + git identity bootstrap
# Read top-level codeRoot/codeOwner/codeGroup/gitName/gitEmail from the
# registry. Warn (don't fail) if the filesystem doesn't match the declared
# intent — operator can decide whether to fix manually or `chown -R` + ACL.
# Auto-create per-coding-agent ~/.gitconfig if missing, with an includeIf
# block that pulls codeRoot/.gitconfig-shared (where the [user] block lives,
# generated from the registry). Idempotent: never clobbers existing config.
log "[4d/7] codeRoot drift check + per-agent git identity"
if [ -r "$REGISTRY" ] && command -v jq >/dev/null 2>&1; then
    CODE_ROOT=$(jq -r '.codeRoot // empty' "$REGISTRY")
    CODE_OWNER=$(jq -r '.codeOwner // empty' "$REGISTRY")
    CODE_GROUP=$(jq -r '.codeGroup // empty' "$REGISTRY")
    GIT_NAME=$(jq -r '.gitName // empty' "$REGISTRY")
    GIT_EMAIL=$(jq -r '.gitEmail // empty' "$REGISTRY")

    if [ -z "$CODE_ROOT" ]; then
        log "  no codeRoot in registry; skipping (add codeRoot/codeOwner/etc to enable)"
    elif [ ! -d "$CODE_ROOT" ]; then
        warn "  codeRoot $CODE_ROOT does not exist on disk"
    else
        # Drift check: owner / group / setgid / ACL
        actual_owner=$(stat -c '%U' "$CODE_ROOT")
        actual_group=$(stat -c '%G' "$CODE_ROOT")
        actual_mode=$(stat -c '%A' "$CODE_ROOT")
        [ "$actual_owner" = "$CODE_OWNER" ] && ok "  $CODE_ROOT owner=$actual_owner" || warn "  $CODE_ROOT owner=$actual_owner (registry says $CODE_OWNER)"
        [ "$actual_group" = "$CODE_GROUP" ] && ok "  $CODE_ROOT group=$actual_group" || warn "  $CODE_ROOT group=$actual_group (registry says $CODE_GROUP)"
        case "$actual_mode" in
            *s*) ok "  $CODE_ROOT setgid bit set (new dirs inherit group)" ;;
            *)   warn "  $CODE_ROOT missing setgid bit ($actual_mode) — new dirs won't inherit $CODE_GROUP" ;;
        esac
        if getfacl -p "$CODE_ROOT" 2>/dev/null | grep -q "^group:$CODE_GROUP:rwx"; then
            ok "  $CODE_ROOT ACL grants group:$CODE_GROUP:rwx"
        else
            warn "  $CODE_ROOT ACL missing group:$CODE_GROUP:rwx — agents may not have write access"
        fi

        # Per-coding-agent git identity drift check: when an agent runs
        # `git config user.{name,email}` inside any repo under codeRoot,
        # the effective values must match gitName/gitEmail from the
        # registry. Otherwise their commits would be attributed to
        # themselves rather than the host's canonical author.
        #
        # We don't auto-fix because each agent's git identity wiring
        # could live in any number of files (~/.gitconfig includeIf,
        # ~/.gitconfig-srv-code, codeRoot/.gitconfig-*, system git
        # config, etc.) and clobbering would risk losing per-agent
        # customizations. Drift here is operator-fixable.
        if [ -n "$GIT_NAME" ] && [ -n "$GIT_EMAIL" ] && [ -d "$CODE_ROOT" ]; then
            # Pick any existing repo under codeRoot to do the check in
            probe_dir=$(find "$CODE_ROOT" -mindepth 1 -maxdepth 2 -name ".git" -print -quit 2>/dev/null | xargs -r dirname)
            if [ -n "$probe_dir" ]; then
                while IFS=$'\t' read -r u h; do
                    [ -z "$u" ] && continue
                    name=$(sudo -n -u "$u" git -C "$probe_dir" config --get user.name 2>/dev/null)
                    email=$(sudo -n -u "$u" git -C "$probe_dir" config --get user.email 2>/dev/null)
                    if [ "$name" = "$GIT_NAME" ] && [ "$email" = "$GIT_EMAIL" ]; then
                        ok "  $u: git identity in $CODE_ROOT = $name <$email>"
                    else
                        warn "  $u: git identity in $CODE_ROOT = '$name <$email>' (registry wants '$GIT_NAME <$GIT_EMAIL>')"
                    fi
                done < <(jq -r '.agents[] | select(.enabled == true and .role == "coding") | "\(.user)\t\(.home // "")"' "$REGISTRY")
            fi
        fi
    fi
fi

# 5. dashboard frontend symlink
log "[5/7] dashboard frontend symlink"
WEB_HTML="$REPO_ROOT/../web/agents.html"
WEB_HTML="$(cd "$(dirname "$WEB_HTML")" && pwd)/$(basename "$WEB_HTML")"
if [ -f "$WEB_HTML" ]; then
    if [ "$DRY" -eq 1 ]; then
        log "  would symlink /usr/local/share/agent-dashboard/agents.html → $WEB_HTML"
    else
        mkdir -p /usr/local/share/agent-dashboard
        ln -snf "$WEB_HTML" /usr/local/share/agent-dashboard/agents.html
        ok "/usr/local/share/agent-dashboard/agents.html → $WEB_HTML"
    fi
else
    warn "  frontend $WEB_HTML not found; skipping symlink"
fi

# 6. systemctl daemon-reload + restart running system units
log "[6/7] systemctl daemon-reload (system + per-user)"
if [ "$DRY" -eq 1 ]; then
    log "  would: systemctl daemon-reload (system)"
    log "  would: per-user daemon-reload for each enabled agent"
    log "  would: restart any system units currently active"
else
    systemctl daemon-reload
    ok "systemctl daemon-reload (system)"
    for u in agent-dashboard.service \
             openclaw-typing-keepalive.service \
             openclaw-monitor-sync.path \
             openclaw-monitor-sync.timer \
             gmail-watch-renew.timer; do
        if systemctl is-enabled --quiet "$u" 2>/dev/null; then
            systemctl restart "$u" || warn "  restart $u failed (continuing)"
        fi
    done
    ok "running system units restarted"
fi

# 7. per-agent user-systemd reconcile
# For each enabled agent, derive the expected openclaw-*.service set
# (from core + byRole + byIntegration in agent-defaults.json) and:
#   - daemon-reload their user instance (pick up /etc/systemd/user/ changes)
#   - enable+start any expected service not yet active
#   - disable+stop any active openclaw-*.service NOT in the expected set
#     (orphan cleanup — e.g. the legacy openclaw-webhook-receiver.service
#      after the split into jira+bitbucket receivers)
log "[7/7] per-agent user-systemd reconcile"
if [ ! -r "$REGISTRY" ] || [ ! -r "$DEFAULTS" ]; then
    warn "  registry or defaults unreadable; skipping reconcile"
elif ! command -v jq >/dev/null 2>&1; then
    warn "  jq not available; skipping reconcile"
else
    # Derive expected openclaw-*.service set per agent, emit "<user> <uid> <svc>" lines.
    DERIVE=$(jq -r --slurpfile defs "$DEFAULTS" '
      .agents[] | select(.enabled == true) | . as $a |
      ($defs[0].core.services // []) +
      (($defs[0].byRole[$a.role].services // [])) +
      ([ ($a.integrations // {}) | to_entries[]
         | select(.value == true)
         | $defs[0].byIntegration[.key].services // [] ] | add // []) +
      ($a.services // [])
      | unique
      | map(select(startswith("openclaw-")))
      | .[] as $svc
      | "\($a.user)\t\($a.uid)\t\($svc)"
    ' "$REGISTRY")

    # Group by user → expected services list
    declare -A EXPECTED_SVCS
    declare -A USER_UID
    while IFS=$'\t' read -r user uid svc; do
        [ -z "$user" ] && continue
        USER_UID[$user]=$uid
        EXPECTED_SVCS[$user]="${EXPECTED_SVCS[$user]:-} $svc"
    done <<< "$DERIVE"

    user_systemctl() {
        local user="$1" uid="$2"; shift 2
        sudo -n -u "$user" \
            env XDG_RUNTIME_DIR="/run/user/$uid" \
                DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
            systemctl --user "$@"
    }

    for user in "${!EXPECTED_SVCS[@]}"; do
        uid="${USER_UID[$user]}"
        expected=$(echo "${EXPECTED_SVCS[$user]}" | tr ' ' '\n' | sort -u | grep -v '^$' || true)
        log "  $user (uid=$uid) expected: $(echo "$expected" | tr '\n' ' ')"

        if [ "$DRY" -eq 0 ]; then
            user_systemctl "$user" "$uid" daemon-reload 2>/dev/null || true
        fi

        # enable+start expected
        while IFS= read -r svc; do
            [ -z "$svc" ] && continue
            if [ "$DRY" -eq 1 ]; then
                log "    would: sudo -u $user systemctl --user enable --now $svc"
                continue
            fi
            current=$(user_systemctl "$user" "$uid" is-active "$svc" 2>/dev/null || true)
            if [ "$current" = "active" ]; then
                continue
            fi
            if user_systemctl "$user" "$uid" enable --now "$svc" 2>/dev/null; then
                ok "    $user: enable+start $svc"
            else
                warn "    $user: failed to enable+start $svc"
            fi
        done <<< "$expected"

        # find orphans (any active openclaw-*.service not in expected)
        if [ "$DRY" -eq 1 ]; then
            log "    would: scan user instance for orphan openclaw-*.service units"
            continue
        fi
        actual=$(user_systemctl "$user" "$uid" list-units --type=service --no-pager --no-legend --state=active,activating,running 'openclaw-*' 2>/dev/null | awk '{print $1}' | sort -u || true)
        while IFS= read -r svc; do
            [ -z "$svc" ] && continue
            if ! echo "$expected" | grep -qx "$svc"; then
                if user_systemctl "$user" "$uid" disable --now "$svc" 2>/dev/null; then
                    ok "    $user: orphan disabled+stopped $svc"
                else
                    warn "    $user: failed to disable orphan $svc"
                fi
            fi
        done <<< "$actual"
    done
fi

echo
log "Done. Enable host-level units on first install:"
log "  sudo systemctl enable --now agent-dashboard.service"
log "  sudo systemctl enable --now openclaw-monitor-sync.path openclaw-monitor-sync.timer"
log "  sudo systemctl enable --now openclaw-typing-keepalive.service   # claude-cli hosts only"
log "  sudo systemctl enable --now gmail-watch-renew.timer            # gmail-integrated hosts only"
log
log "Per-agent user units (openclaw-gateway, gmail-listener, mail-listener,"
log "jira-receiver, bitbucket-receiver, webhook-receiver) are reconciled"
log "automatically by step [7/7] above based on each agent's derived service set."
