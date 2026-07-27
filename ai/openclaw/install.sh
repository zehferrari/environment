#!/bin/bash
# install.sh — deploy OpenClaw host-level scripts + systemd units.
#
# Idempotent: re-running with no source changes is a no-op modulo a few
# stat/md5 checks. Designed to be run after every `git pull` in this
# repo working tree, or on a fresh host as part of bootstrap.
#
# What it does:
#   1. install bin/ scripts to /usr/local/bin and /usr/local/sbin and
#      apply the OpenClaw session-fence runtime patch when present
#   2. install systemd/ system units to /etc/systemd/system
#   3. install systemd/user/ user units to /etc/systemd/user (admin-installed
#      user units, visible to every user's systemd instance — only the
#      monitor agent enables them based on derived services)
#   4. generate/sync host-specific assets from agents.json — fans out into
#      sub-steps [4/7]..[4f/7]: openclaw-monitor-sync.path (4), webhook
#      script symlinks (4b) + agent provisioning runner (4b.2), agent-self
#      symlinks (4c), codeRoot drift check + per-agent git identity (4d),
#      gmail helpers (4e), and the host-wide PM web service, PM dispatch
#      drop, consumer service, local gateway /hooks/wake tokens, and the
#      native PM channel plugin/token map (4f)
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
PM_WEB_ROOT="${PM_WEB_ROOT:-$REPO_ROOT/../web}"
PM_ENV_FILE="${PM_ENV_FILE:-/etc/default/pm}"
PM_DROP_DIR="${PM_DROP_DIR:-/var/lib/pm/drop}"
PM_STATE_DIR="${PM_STATE_DIR:-$(dirname "$PM_DROP_DIR")}"
PM_ATTACHMENT_ROOT="${PM_ATTACHMENT_ROOT:-/srv/Data/projects}"
PM_SAMBA_SHARED_ROOT="${PM_SAMBA_SHARED_ROOT:-/srv/samba/shared}"
PM_CONSUMER_PNPM_HOME="${PM_CONSUMER_PNPM_HOME:-$PM_STATE_DIR/pnpm-home}"
PM_CONSUMER_PNPM_CONFIG_HOME="${PM_CONSUMER_PNPM_CONFIG_HOME:-$PM_STATE_DIR/pnpm-config}"
PM_CONSUMER_PNPM_CACHE_HOME="${PM_CONSUMER_PNPM_CACHE_HOME:-$PM_STATE_DIR/pnpm-cache}"
PM_AGENT_CREDENTIALS_DIR="${PM_AGENT_CREDENTIALS_DIR:-/etc/openclaw/pm-agent-credentials}"
PM_CONSUMER_TOKEN_FILE="${PM_CONSUMER_TOKEN_FILE:-/etc/openclaw/pm-consumer-tokens.json}"
PM_APP_USER="${PM_APP_USER:-${PM_CONSUMER_USER:-karen}}"
PM_APP_GROUP="${PM_APP_GROUP:-${PM_CONSUMER_GROUP:-$PM_APP_USER}}"
PM_NODE_BIN="${PM_NODE_BIN:-/usr/bin/node24}"
PM_PNPM_BIN="${PM_PNPM_BIN:-/usr/local/bin/pnpm}"
PM_OPENCLAW_CHANNEL_TOKEN_FILE="${PM_OPENCLAW_CHANNEL_TOKEN_FILE:-/etc/openclaw/pm-channel-tokens.json}"
PM_OPENCLAW_CHANNEL_TOKEN_GROUP="${PM_OPENCLAW_CHANNEL_TOKEN_GROUP:-$PM_APP_GROUP}"
OPENCLAW_SESSION_FENCE_PATCH="${OPENCLAW_SESSION_FENCE_PATCH:-1}"
OPENCLAW_SESSION_FENCE_PATCH_FILE="${OPENCLAW_SESSION_FENCE_PATCH_FILE:-/usr/local/lib/node_modules/openclaw/dist/selection-hR-AeOeU.js}"
# Final durable reply callback configured into the OpenClaw pm channel plugin.
# The live partial-reply stream callback is sent by PM per turn as
# /api/openclaw/pm-channel/stream, derived from PM_AGENT_CALLBACK_URL or
# PM_INTERNAL_APP_URL in /etc/default/pm.
PM_OPENCLAW_CHANNEL_CALLBACK_URL="${PM_OPENCLAW_CHANNEL_CALLBACK_URL:-http://127.0.0.1:3000/api/openclaw/pm-channel/reply}"

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

generate_hook_token() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
        return
    fi
    LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 64
    printf '\n'
}

hook_token_for_agent() {
    local agent="$1" cfg="$2" token=""
    if [ -r "$PM_CONSUMER_TOKEN_FILE" ] && command -v jq >/dev/null 2>&1; then
        token=$(jq -r --arg agent "$agent" '.[$agent] // empty' "$PM_CONSUMER_TOKEN_FILE" 2>/dev/null || true)
    fi
    if [ -z "$token" ] && [ -r "$cfg" ] && command -v jq >/dev/null 2>&1; then
        token=$(jq -r '.hooks.token // empty' "$cfg" 2>/dev/null || true)
    fi
    if [ -z "$token" ]; then
        token=$(generate_hook_token)
    fi
    printf '%s\n' "$token"
}

# 1. bin scripts
log "[1/7] bin scripts"
do_install 755 "$REPO_ROOT/bin/ai-monitor"                /usr/local/bin/ai-monitor
do_install 755 "$REPO_ROOT/bin/openclaw-registry-check"   /usr/local/bin/openclaw-registry-check
do_install 755 "$REPO_ROOT/bin/openclaw-integrity-check"  /usr/local/bin/openclaw-integrity-check
do_install 755 "$REPO_ROOT/bin/openclaw-control"          /usr/local/sbin/openclaw-control
do_install 755 "$REPO_ROOT/bin/openclaw-manage-user"     /usr/local/sbin/openclaw-manage-user
do_install 755 "$REPO_ROOT/bin/claim-branch"              /usr/local/bin/claim-branch
do_install 755 "$REPO_ROOT/bin/openclaw-doc-sync"       /usr/local/sbin/openclaw-doc-sync
do_install 755 "$REPO_ROOT/bin/openclaw-agent-runner"    /usr/local/sbin/openclaw-agent-runner
do_install 755 "$REPO_ROOT/bin/pm-workflow-nudge"         /usr/local/sbin/pm-workflow-nudge
do_install 755 "$REPO_ROOT/bin/pm-self-assignment-guard" /usr/local/sbin/pm-self-assignment-guard
do_install 755 "$REPO_ROOT/bin/openclaw-patch-session-fence" /usr/local/sbin/openclaw-patch-session-fence
do_install 755 "$REPO_ROOT/bin/agent-dashboard"           /usr/local/bin/agent-dashboard
do_install 755 "$REPO_ROOT/bin/openclaw-monitor-sync"     /usr/local/sbin/openclaw-monitor-sync
do_install 755 "$REPO_ROOT/bin/openclaw-typing-keepalive" /usr/local/bin/openclaw-typing-keepalive
do_install 755 "$REPO_ROOT/bin/gmail-watch-renew-all"     /usr/local/sbin/gmail-watch-renew-all
do_install 755 "$REPO_ROOT/bin/code-tree-perms"           /usr/local/sbin/code-tree-perms
do_install 755 "$REPO_ROOT/bin/openclaw-backup"           /usr/local/bin/openclaw-backup
do_install 755 "$REPO_ROOT/bin/openclaw-boot-readiness"   /usr/local/bin/openclaw-boot-readiness
do_install 755 "$REPO_ROOT/bin/pm-monitor-wake-agent"     /usr/local/sbin/pm-monitor-wake-agent

# Shared derivation defaults consumed by step [7/7], ai-monitor,
# agent-dashboard, and openclaw-integrity-check. Installed as a COPY (never a
# symlink into a checkout) so /etc does not depend on repo tree state; step 7
# silently skips the whole per-agent reconcile when this file is missing.
if [ "$DRY" -eq 1 ]; then
    log "  would install -m 644 $REPO_ROOT/agent-defaults.json → /etc/openclaw/agent-defaults.json"
else
    install -d -o root -g root -m 0755 /etc/openclaw
    if [ -L /etc/openclaw/agent-defaults.json ]; then
        rm -f /etc/openclaw/agent-defaults.json   # replace legacy checkout symlink with a real copy
    fi
fi
do_install 644 "$REPO_ROOT/agent-defaults.json"           /etc/openclaw/agent-defaults.json
if [ "$OPENCLAW_SESSION_FENCE_PATCH" != "0" ] && [ "$OPENCLAW_SESSION_FENCE_PATCH" != "false" ]; then
    if [ "$DRY" -eq 1 ]; then
        log "  would patch OpenClaw session fence at $OPENCLAW_SESSION_FENCE_PATCH_FILE"
    elif [ -x "$PM_NODE_BIN" ]; then
        "$PM_NODE_BIN" "$REPO_ROOT/bin/openclaw-patch-session-fence" --file "$OPENCLAW_SESSION_FENCE_PATCH_FILE" \
            || warn "  OpenClaw session-fence patch failed (continuing)"
    else
        warn "  node not found/executable at $PM_NODE_BIN; skipping OpenClaw session-fence patch"
    fi
else
    log "  OpenClaw session-fence patch disabled by OPENCLAW_SESSION_FENCE_PATCH=$OPENCLAW_SESSION_FENCE_PATCH"
fi

# 2. system-wide systemd units (host-portable)
log "[2/7] systemd system units"
for u in agent-dashboard.service \
         ai-monitor.service ai-monitor.timer \
         openclaw-integrity.service openclaw-integrity.timer \
         openclaw-backup.service openclaw-backup.timer \
         openclaw-doc-sync.service openclaw-doc-sync.timer \
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
#
# Symlinked back to the canonical repo copy (like agent-self.js in 4c) so
# the deployed tree and source can't drift — a stale on-disk copy is how
# the receivers ended up serving an out-of-date routing list. NOTE: node
# loads the script once at process start, so a *code* change still needs a
# receiver restart to take effect (step 7 reconcile / manual restart);
# the live registry reload is handled in common.js, not by these links.
log "[4b/7] webhook scripts → monitor agent home (symlinks)"
if [ -d "$REPO_ROOT/webhooks" ] && [ -r "$REGISTRY" ] && command -v jq >/dev/null 2>&1; then
    MONITOR_LINE=$(jq -r '.agents[] | select(.role == "monitor" and .enabled == true) | "\(.user)\t\(.home // "/home/\(.user)")"' "$REGISTRY" | head -1)
    if [ -n "$MONITOR_LINE" ]; then
        m_user=$(echo "$MONITOR_LINE" | cut -f1)
        m_home=$(echo "$MONITOR_LINE" | cut -f2)
        dst="$m_home/webhooks"
        if [ "$DRY" -eq 1 ]; then
            log "  would symlink webhooks/*.js → $dst/ (owner=$m_user)"
        else
            # Mkdir as the agent (avoid a root-owned webhooks dir).
            sudo -u "$m_user" mkdir -p "$dst" 2>/dev/null
            for src in "$REPO_ROOT"/webhooks/*.js; do
                [ -e "$src" ] || continue
                lnk="$dst/$(basename "$src")"
                sudo -u "$m_user" ln -snf "$src" "$lnk" && ok "$lnk → $src"
            done
        fi
    else
        warn "  no monitor agent in registry — skipping webhook scripts"
    fi
fi

# 4b.2 agent provisioning runner (openclaw-agent-runner.service)
# The PM web app (pm.service) is NoNewPrivileges and cannot sudo. It spools a
# request; this monitor-owned runner (NOT NoNewPrivileges) runs the privileged
# openclaw-manage-user step and writes a result the web app polls for.
log "[4b.2/7] agent provisioning runner"
RUNNER_MONITOR=""
if [ -r "$REGISTRY" ] && command -v jq >/dev/null 2>&1; then
    RUNNER_MONITOR=$(jq -r '.agents[] | select(.role == "monitor" and .enabled == true) | .user' "$REGISTRY" | head -1)
fi
RUNNER_MONITOR="${RUNNER_MONITOR:-karen}"
PM_AGENT_PROVISION_DIR="${PM_AGENT_PROVISION_DIR:-/var/lib/pm/agent-provision}"
if [ "$DRY" -eq 1 ]; then
    log "  would install openclaw-agent-runner.service (User=$RUNNER_MONITOR)"
    log "  would install -d -o $RUNNER_MONITOR -g code-agents -m 0700 $PM_AGENT_PROVISION_DIR"
else
    TMP_UNIT=$(mktemp)
    sed "s|__MONITOR_USER__|$RUNNER_MONITOR|g" "$REPO_ROOT/systemd/openclaw-agent-runner.service" > "$TMP_UNIT"
    install -o root -g root -m 644 "$TMP_UNIT" /etc/systemd/system/openclaw-agent-runner.service
    rm -f "$TMP_UNIT"
    install -d -o "$RUNNER_MONITOR" -g code-agents -m 0700 "$PM_AGENT_PROVISION_DIR"
    ok "openclaw-agent-runner.service (User=$RUNNER_MONITOR) + $PM_AGENT_PROVISION_DIR"
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

        # Per-coding-agent git identity bootstrap + drift check.
        #
        # Two modes:
        #   (1) HOST-level override: registry has top-level gitName/gitEmail.
        #       Every coding agent's commits under codeRoot are attributed
        #       to that single identity (e.g. thinkpad: gitName="Zeh Ferrari").
        #       install.sh maintains <codeRoot>/.gitconfig-registry with
        #       [user] from those fields and links agent ~/.gitconfig to it
        #       via includeIf.
        #   (2) PER-AGENT identity: registry has NO host-level gitName/
        #       gitEmail. Each agent commits as themselves — install.sh
        #       writes the agent's own .name and .email (from the per-agent
        #       record) directly into ~/.gitconfig.
        #
        # In both cases:
        # - safe.directory = codeRoot/* is added BEFORE the [user] /
        #   includeIf block so git can determine the gitdir on cross-user
        #   repos (otherwise the includeIf can never resolve).
        # - includeIf uses trailing-slash form `gitdir:codeRoot/` for
        #   recursive match. `codeRoot/*` (single star) does NOT match
        #   the .git dir one level deeper.
        # - Existing ~/.gitconfig files are NEVER clobbered (almost
        #   certainly operator-curated with sshCommand, signing key,
        #   etc.) — drift surfaces as a warning instead.
        REGISTRY_GITCFG="$CODE_ROOT/.gitconfig-registry"
        if [ -d "$CODE_ROOT" ]; then
            probe_dir=$(find "$CODE_ROOT" -mindepth 1 -maxdepth 2 -name ".git" -print -quit 2>/dev/null | xargs -r dirname)

            # Host-override mode: maintain the shared registry-managed file
            # once before iterating agents. Skipped entirely if no host-level
            # gitName/gitEmail in registry (per-agent mode).
            if [ -n "$GIT_NAME" ] && [ -n "$GIT_EMAIL" ]; then
                if [ "$DRY" -eq 1 ]; then
                    log "  would reconcile $REGISTRY_GITCFG with [user] from registry"
                elif [ ! -f "$REGISTRY_GITCFG" ]; then
                    printf '# Managed by install.sh from /etc/openclaw/agents.json gitName/gitEmail.\n# Pulled into every repo under %s by per-agent ~/.gitconfig includeIf.\n# Operator-managed git files (e.g. .gitconfig-zeh with [core] sshCommand)\n# stay separate from this file and are not touched by install.sh.\n[user]\n\tname = %s\n\temail = %s\n' \
                        "$CODE_ROOT" "$GIT_NAME" "$GIT_EMAIL" > "$REGISTRY_GITCFG"
                    chown "$CODE_OWNER:$CODE_GROUP" "$REGISTRY_GITCFG" 2>/dev/null
                    chmod 0644 "$REGISTRY_GITCFG"
                    ok "  created $REGISTRY_GITCFG"
                else
                    git config --file "$REGISTRY_GITCFG" user.name  "$GIT_NAME"
                    git config --file "$REGISTRY_GITCFG" user.email "$GIT_EMAIL"
                fi
            fi

            while IFS=$'\t' read -r u h name email; do
                [ -z "$u" ] && continue
                home="${h:-/home/$u}"
                gcfg="$home/.gitconfig"

                # Pick identity: host override wins if set; otherwise the
                # agent's own name+email from their registry record.
                if [ -n "$GIT_NAME" ] && [ -n "$GIT_EMAIL" ]; then
                    want_name="$GIT_NAME"; want_email="$GIT_EMAIL"
                    mode_label="host override"
                else
                    want_name="$name"; want_email="$email"
                    mode_label="own identity"
                fi
                if [ -z "$want_name" ] || [ -z "$want_email" ]; then
                    warn "  $u: no name/email to bootstrap git identity (registry missing fields)"
                    continue
                fi

                # Bootstrap ~/.gitconfig if missing.
                #
                # safe.directory MUST appear before the [user] / includeIf
                # block — without it, git refuses to determine the gitdir
                # on repos owned by another user (rachael/zeh on the shared
                # tree) and includeIf can never match because the gitdir
                # lookup itself fails the safety check.
                #
                # Two layouts depending on mode:
                #   host override: scoped via includeIf gitdir:codeRoot/ →
                #     codeRoot/.gitconfig-registry (so identity only
                #     applies to repos under codeRoot, not to the agent's
                #     personal repos elsewhere).
                #   per-agent:     [user] block written directly (agent's
                #     own identity applies everywhere they commit).
                #
                # includeIf gitdir pattern uses TRAILING SLASH (no glob)
                # for recursive match: `gitdir:/srv/Code/` matches any
                # .git dir under /srv/Code/ at any depth.
                if [ ! -f "$gcfg" ]; then
                    if [ "$DRY" -eq 1 ]; then
                        log "  would create $gcfg ($mode_label: $want_name <$want_email>)"
                    else
                        TMPG=$(mktemp)
                        if [ -n "$GIT_NAME" ] && [ -n "$GIT_EMAIL" ]; then
                            printf '# Generated by openclaw install.sh — commits under %s use\n# the host gitName/gitEmail from /etc/openclaw/agents.json.\n[safe]\n\tdirectory = %s/*\n[includeIf "gitdir:%s/"]\n\tpath = %s\n' \
                                "$CODE_ROOT" "$CODE_ROOT" "$CODE_ROOT" "$REGISTRY_GITCFG" > "$TMPG"
                        else
                            printf '# Generated by openclaw install.sh — commits attributed to\n# this agent (name + email from /etc/openclaw/agents.json).\n[safe]\n\tdirectory = %s/*\n[user]\n\tname = %s\n\temail = %s\n' \
                                "$CODE_ROOT" "$want_name" "$want_email" > "$TMPG"
                        fi
                        install -o "$u" -g "$u" -m 0644 "$TMPG" "$gcfg"
                        rm -f "$TMPG"
                        ok "  $u: created $gcfg ($mode_label: $want_name <$want_email>)"
                    fi
                fi

                # Drift check: effective git identity inside a codeRoot repo
                if [ -n "$probe_dir" ] && [ "$DRY" -eq 0 ]; then
                    actual_name=$(sudo -n -u "$u" git -C "$probe_dir" config --get user.name 2>/dev/null)
                    actual_email=$(sudo -n -u "$u" git -C "$probe_dir" config --get user.email 2>/dev/null)
                    if [ "$actual_name" = "$want_name" ] && [ "$actual_email" = "$want_email" ]; then
                        ok "  $u: git identity in $CODE_ROOT = $actual_name <$actual_email>"
                    else
                        warn "  $u: git identity in $CODE_ROOT = '$actual_name <$actual_email>' (registry wants '$want_name <$want_email>') — review $gcfg"
                    fi
                fi
            done < <(jq -r '.agents[] | select(.enabled == true and .role == "coding") | "\(.user)\t\(.home // "")\t\(.name // "")\t\(.email // "")"' "$REGISTRY")
        fi
    fi
fi

# 4e. sync gmail helpers (mime.js + gmail-send.js + gmail-reply.js) into
# each gmail-integrated coding agent's workspace/google directories.
#
# Background: agents invoke gmail-send.js / gmail-reply.js from
# /home/<u>/workspace/google/ (per the google-workspace skill description),
# NOT from the symlinked /home/<u>/.openclaw/skills/google-workspace/.
# Updates to the shared repo never reach the workspace copies on their
# own, so we sync them here every install.sh run.
#
# We copy (not symlink) because each agent's workspace/google has its
# own node_modules/, secrets/, package.json — symlinking the whole dir
# would lose those. Symlinking individual files works in principle but
# breaks Node's module resolution unless we also install node_modules
# in the repo. Copying keeps each agent fully self-contained.
log "[4e/7] sync gmail helpers to each gmail-integrated coding agent"
if [ -r "$REGISTRY" ] && command -v jq >/dev/null 2>&1; then
    while IFS=$'\t' read -r u h; do
        [ -z "$u" ] && continue
        home="${h:-/home/$u}"
        for d in "$home/workspace/google" "$home/.openclaw/workspace/google"; do
            [ -d "$d" ] || continue
            for f in mime.js gmail-send.js gmail-reply.js; do
                src="$REPO_ROOT/skills/google-workspace/$f"
                dst="$d/$f"
                [ -f "$src" ] || continue
                if [ -L "$dst" ]; then
                    continue  # symlink already in place — leave it
                fi
                if [ "$DRY" -eq 1 ]; then
                    log "  would copy $src → $dst"
                    continue
                fi
                if ! cmp -s "$src" "$dst" 2>/dev/null; then
                    install -o "$u" -g "$u" -m 0644 "$src" "$dst"
                    ok "  $u: $dst"
                fi
            done
        done
    done < <(jq -r '.agents[] | select(.enabled == true and .role == "coding" and (.integrations.gmail // false)) | "\(.user)\t\(.home // "")"' "$REGISTRY")
fi

# 4f. PM web service + dispatch file-drop + consumer + local gateway hooks/channel
log "[4f/7] PM web service + non-chat /hooks/wake + native channel"
PM_WEB_ROOT="$(cd "$PM_WEB_ROOT" 2>/dev/null && pwd || printf '%s' "$PM_WEB_ROOT")"
if [ ! -d "$PM_WEB_ROOT" ]; then
    warn "  PM web root $PM_WEB_ROOT not found; skipping PM web/consumer install"
else
    if [ "$DRY" -ne 1 ]; then
        [ -x "$PM_NODE_BIN" ] || { warn "  node not found/executable at $PM_NODE_BIN"; exit 1; }
        [ -x "$PM_PNPM_BIN" ] || { warn "  pnpm not found/executable at $PM_PNPM_BIN"; exit 1; }
    fi
    pm_app_user="$PM_APP_USER"
    pm_app_group="$PM_APP_GROUP"
    pm_user="${PM_CONSUMER_USER:-$pm_app_user}"
    pm_group="${PM_CONSUMER_GROUP:-$pm_app_group}"
    pm_unit_src="$PM_WEB_ROOT/deploy/pm.service"
    consumer_unit_src="$PM_WEB_ROOT/deploy/pm-consumer.service"
    channel_installer="$PM_WEB_ROOT/deploy/install-openclaw-pm-channel.mjs"
    pm_channel_agent_root="${PM_OPENCLAW_AGENT_ROOT:-/srv/agents/openclaw}"
    pm_channel_agents=""
    if [ -r "$REGISTRY" ] && command -v jq >/dev/null 2>&1; then
        registry_agent_root=$(jq -r '.agentFilesRoot // empty' "$REGISTRY" 2>/dev/null || true)
        [ -n "$registry_agent_root" ] && pm_channel_agent_root="$registry_agent_root"
        pm_channel_agents=$(jq -r '[.agents[] | select(.enabled == true and (.user // "") != "") | .user] | join(",")' "$REGISTRY" 2>/dev/null || true)
    fi

    if [ "$DRY" -eq 1 ]; then
        log "  would install -d -o $pm_app_user -g $pm_app_group -m 0700 $PM_AGENT_CREDENTIALS_DIR"
        log "  would install -d -o $pm_user -g $pm_group -m 0700 $PM_DROP_DIR"
        log "  would install -d -o $pm_app_user -g $pm_app_group -m 0700 $PM_ATTACHMENT_ROOT"
        log "  would install -d -o root -g root -m 0755 $PM_SAMBA_SHARED_ROOT and grant $pm_app_user ACL write access"
        log "  would provision pm-consumer pnpm home/config/cache under $PM_STATE_DIR"
        log "  would remove stale per-agent user pm.service / pm-consumer.service units"
        log "  would bind agent gateways to loopback, enable /hooks/wake for non-chat automation with hook:/pm: session keys, and reconcile $PM_CONSUMER_TOKEN_FILE (root:$pm_group 0640)"
        log "  would reconcile native PM channel tokens at $PM_OPENCLAW_CHANNEL_TOKEN_FILE (root:$PM_OPENCLAW_CHANNEL_TOKEN_GROUP 0640)"
        log "  would configure native PM channel final callback $PM_OPENCLAW_CHANNEL_CALLBACK_URL"
        if [ -n "$pm_channel_agents" ]; then
            log "  would configure native PM channel for enabled agents: $pm_channel_agents"
        else
            log "  would let native PM channel installer discover enabled agents from $REGISTRY"
        fi
        log "  PM sends the live stream callback per turn as /api/openclaw/pm-channel/stream from its callback base and tracks durable PmChannelRun state; success still requires the final reply callback"
        if [ -f "$pm_unit_src" ]; then
            log "  would render $pm_unit_src → /etc/systemd/system/pm.service"
        else
            warn "  missing $pm_unit_src; skipping pm.service"
        fi
        if [ -f "$consumer_unit_src" ]; then
            log "  would render $consumer_unit_src → /etc/systemd/system/pm-consumer.service"
        else
            warn "  missing $consumer_unit_src; skipping pm-consumer.service"
        fi
        if [ -f "$channel_installer" ]; then
            log "  would run $PM_NODE_BIN $channel_installer --registry $REGISTRY --agent-root $pm_channel_agent_root --callback-url $PM_OPENCLAW_CHANNEL_CALLBACK_URL --restart"
        else
            warn "  missing $channel_installer; skipping native PM channel install"
        fi
    else
        install -d -o "$pm_app_user" -g "$pm_app_group" -m 0700 "$PM_AGENT_CREDENTIALS_DIR"
        ok "$PM_AGENT_CREDENTIALS_DIR"
        install -d -o "$pm_app_user" -g "$pm_app_group" -m 0770 "$PM_WEB_ROOT/.data"
        ok "$PM_WEB_ROOT/.data"
        install -d -o "$pm_user" -g "$pm_group" -m 0700 "$PM_DROP_DIR"
        ok "$PM_DROP_DIR"
        install -d -o "$pm_app_user" -g "$pm_app_group" -m 0700 "$PM_ATTACHMENT_ROOT"
        ok "$PM_ATTACHMENT_ROOT"
        install -d -o root -g root -m 0755 "$PM_SAMBA_SHARED_ROOT"
        ok "$PM_SAMBA_SHARED_ROOT"
        install -d -o "$pm_user" -g "$pm_group" -m 0700 \
            "$PM_CONSUMER_PNPM_HOME" \
            "$PM_CONSUMER_PNPM_CONFIG_HOME" \
            "$PM_CONSUMER_PNPM_CACHE_HOME" \
            "$PM_CONSUMER_PNPM_CONFIG_HOME/pnpm"
        if [ ! -f "$PM_CONSUMER_PNPM_HOME/.npmrc" ]; then
            install -o "$pm_user" -g "$pm_group" -m 0600 /dev/null "$PM_CONSUMER_PNPM_HOME/.npmrc"
        else
            chown "$pm_user:$pm_group" "$PM_CONSUMER_PNPM_HOME/.npmrc" 2>/dev/null || true
            chmod 0600 "$PM_CONSUMER_PNPM_HOME/.npmrc" 2>/dev/null || true
        fi
        if [ ! -f "$PM_CONSUMER_PNPM_CONFIG_HOME/pnpm/rc" ]; then
            install -o "$pm_user" -g "$pm_group" -m 0600 /dev/null "$PM_CONSUMER_PNPM_CONFIG_HOME/pnpm/rc"
        else
            chown "$pm_user:$pm_group" "$PM_CONSUMER_PNPM_CONFIG_HOME/pnpm/rc" 2>/dev/null || true
            chmod 0600 "$PM_CONSUMER_PNPM_CONFIG_HOME/pnpm/rc" 2>/dev/null || true
        fi
        ok "pm-consumer pnpm home/config/cache under $PM_STATE_DIR"
        if command -v setfacl >/dev/null 2>&1; then
            acl_path="$PM_WEB_ROOT"
            while [ "$acl_path" != "/" ] && [ -n "$acl_path" ]; do
                setfacl -m "u:$pm_app_user:x" "$acl_path" 2>/dev/null || true
                acl_path=$(dirname "$acl_path")
            done
            setfacl -R -m "u:$pm_app_user:rx" "$PM_WEB_ROOT" 2>/dev/null || true
            [ -d "$PM_WEB_ROOT/prisma" ] && setfacl -R -m "u:$pm_app_user:rwx" "$PM_WEB_ROOT/prisma" 2>/dev/null || true
            [ -d "$PM_WEB_ROOT/prisma" ] && setfacl -dR -m "u:$pm_app_user:rwx" "$PM_WEB_ROOT/prisma" 2>/dev/null || true
            [ -d "$PM_WEB_ROOT/.data" ] && setfacl -R -m "u:$pm_app_user:rwx" "$PM_WEB_ROOT/.data" 2>/dev/null || true
            [ -d "$PM_WEB_ROOT/.data" ] && setfacl -dR -m "u:$pm_app_user:rwx" "$PM_WEB_ROOT/.data" 2>/dev/null || true
            [ -d "$PM_SAMBA_SHARED_ROOT" ] && find "$PM_SAMBA_SHARED_ROOT" -type d -exec setfacl -m "u:$pm_app_user:rwx,d:u:$pm_app_user:rwx" {} + 2>/dev/null || true
            [ -d "$PM_SAMBA_SHARED_ROOT" ] && find "$PM_SAMBA_SHARED_ROOT" -type f -exec setfacl -m "u:$pm_app_user:rw" {} + 2>/dev/null || true
            ok "runtime ACLs for $pm_app_user on PM bundle/data paths"
        else
            warn "  setfacl unavailable; ensure $pm_app_user can read .next/standalone and write prisma/.data plus $PM_SAMBA_SHARED_ROOT"
        fi

        if [ -r "$REGISTRY" ] && command -v jq >/dev/null 2>&1; then
            while IFS=$'\t' read -r user uid home; do
                [ -z "$user" ] && continue
                [ -n "$home" ] || home="/home/$user"
                unit_dir="$home/.config/systemd/user"
                rm -rf \
                    "$unit_dir/pm.service" \
                    "$unit_dir/pm-consumer.service" \
                    "$unit_dir/pm.service.d" \
                    "$unit_dir/pm-consumer.service.d" \
                    "$unit_dir/default.target.wants/pm.service" \
                    "$unit_dir/default.target.wants/pm-consumer.service"
                [ -n "$uid" ] || uid=$(id -u "$user" 2>/dev/null || true)
                if [ -n "$uid" ]; then
                    sudo -n -u "$user" \
                        env XDG_RUNTIME_DIR="/run/user/$uid" \
                            DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
                        systemctl --user daemon-reload 2>/dev/null || true
                fi
            done < <(jq -r '.agents[] | select(.enabled == true) | "\(.user)\t\(.uid // "")\t\(.home // "")"' "$REGISTRY")
            ok "removed stale per-agent user pm.service / pm-consumer.service units"
        else
            warn "  registry or jq unavailable; cannot remove stale per-agent PM user units"
        fi

        install -d -o root -g root -m 0755 "$(dirname "$PM_CONSUMER_TOKEN_FILE")"
        install -d -o root -g root -m 0755 "$(dirname "$PM_OPENCLAW_CHANNEL_TOKEN_FILE")"
        if [ -f "$PM_ENV_FILE" ]; then
            chown "root:$pm_app_group" "$PM_ENV_FILE" 2>/dev/null || true
            chmod 0640 "$PM_ENV_FILE" 2>/dev/null || true
            ok "$PM_ENV_FILE"
            if grep -Eq '^(PM_AGENT_CALLBACK_URL|PM_INTERNAL_APP_URL)=' "$PM_ENV_FILE"; then
                log "  PM callback base configured in $PM_ENV_FILE"
            else
                log "  PM callback base not set in $PM_ENV_FILE; PM defaults native reply/stream callbacks to http://127.0.0.1:3000"
            fi
        else
            warn "  $PM_ENV_FILE does not exist; create it from deploy/pm.env.example before starting pm.service"
        fi
        tmp_tokens=$(mktemp)
        if [ -r "$PM_CONSUMER_TOKEN_FILE" ]; then
            if command -v jq >/dev/null 2>&1 && jq empty "$PM_CONSUMER_TOKEN_FILE" >/dev/null 2>&1; then
                cp "$PM_CONSUMER_TOKEN_FILE" "$tmp_tokens"
            elif ! command -v jq >/dev/null 2>&1; then
                cp "$PM_CONSUMER_TOKEN_FILE" "$tmp_tokens"
                warn "  jq unavailable; preserving $PM_CONSUMER_TOKEN_FILE without hook-token reconciliation"
            else
                printf '{}\n' > "$tmp_tokens"
                warn "  $PM_CONSUMER_TOKEN_FILE is not valid JSON; replacing it with a regenerated token map"
            fi
        else
            printf '{}\n' > "$tmp_tokens"
        fi

        if [ -r "$REGISTRY" ] && command -v jq >/dev/null 2>&1; then
            agent_files_root=$(jq -r '.agentFilesRoot // "/srv/agents/openclaw"' "$REGISTRY")
            agent_config_group=$(jq -r '.codeGroup // empty' "$REGISTRY")
            while IFS=$'\t' read -r user uid port home; do
                [ -z "$user" ] && continue
                [ -n "$home" ] || home="/home/$user"
                cfg="$agent_files_root/$user/openclaw.json"
                if [ ! -f "$cfg" ]; then
                    warn "  $user: missing $cfg; cannot enable /hooks/wake"
                    continue
                fi

                token=$(hook_token_for_agent "$user" "$cfg")
                tmp_cfg=$(mktemp)
                if ! jq --arg token "$token" '
                    .gateway = ((.gateway // {}) + {
                        bind: "loopback",
                        trustedProxies: ["127.0.0.1", "::1"]
                    })
                    | .gateway.auth = ((.gateway.auth // {}) + {
                        trustedProxy: ((.gateway.auth.trustedProxy // {}) + {
                            allowLoopback: true,
                            userHeader: ((.gateway.auth.trustedProxy.userHeader) // "x-forwarded-user")
                        })
                    })
                    | .hooks = ((.hooks // {}) + {
                        enabled: true,
                        path: "/hooks",
                        token: $token,
                        allowRequestSessionKey: true
                    })
                    | .hooks.allowedSessionKeyPrefixes = (((.hooks.allowedSessionKeyPrefixes // []) + ["hook:", "pm:"]) | unique)
                ' "$cfg" > "$tmp_cfg"; then
                    warn "  $user: $cfg is not valid JSON; leaving gateway bind/hooks unchanged"
                    rm -f "$tmp_cfg"
                    continue
                fi

                cfg_group="$agent_config_group"
                [ -n "$cfg_group" ] || cfg_group=$(id -gn "$user" 2>/dev/null || stat -c '%G' "$cfg" 2>/dev/null || printf '%s' "$user")
                cfg_mode=$(stat -c '%a' "$cfg" 2>/dev/null || printf '0660')
                changed=0
                if ! cmp -s "$tmp_cfg" "$cfg"; then
                    if install -o "$user" -g "$cfg_group" -m "$cfg_mode" "$tmp_cfg" "$cfg"; then
                        ok "  $user: bound gateway to loopback and enabled /hooks/wake hook:/pm: session keys in $cfg"
                        changed=1
                    else
                        warn "  $user: failed to write $cfg; leaving token map unchanged for this agent"
                        rm -f "$tmp_cfg"
                        continue
                    fi
                else
                    chown "$user:$cfg_group" "$cfg" 2>/dev/null || true
                    chmod "$cfg_mode" "$cfg" 2>/dev/null || true
                    log "  $user: gateway already loopback-bound with /hooks/wake hook:/pm: session keys enabled"
                fi
                rm -f "$tmp_cfg"

                home_cfg="$home/.openclaw/openclaw.json"
                cfg_real=$(readlink -f "$cfg" 2>/dev/null || printf '%s' "$cfg")
                if [ -L "$home_cfg" ]; then
                    home_real=$(readlink -f "$home_cfg" 2>/dev/null || true)
                    if [ "$home_real" = "$cfg_real" ]; then
                        log "  $user: $home_cfg already points at $cfg"
                    else
                        ln -snf "$cfg" "$home_cfg"
                        chown -h "$user:$user" "$home_cfg" 2>/dev/null || true
                        ok "  $user: repointed $home_cfg -> $cfg"
                    fi
                elif [ -e "$home_cfg" ]; then
                    if cmp -s "$home_cfg" "$cfg"; then
                        backup="$home_cfg.pre-symlink-$(date +%Y%m%d%H%M%S)"
                        mv "$home_cfg" "$backup"
                        ln -s "$cfg" "$home_cfg"
                        chown -h "$user:$user" "$home_cfg" 2>/dev/null || true
                        ok "  $user: replaced duplicate $home_cfg with symlink to $cfg (backup: $backup)"
                    else
                        warn "  $user: $home_cfg differs from $cfg; leaving regular file in place. Reconcile before symlinking."
                    fi
                else
                    install -d -o "$user" -g "$user" -m 0700 "$home/.openclaw" 2>/dev/null || true
                    ln -s "$cfg" "$home_cfg"
                    chown -h "$user:$user" "$home_cfg" 2>/dev/null || true
                    ok "  $user: created $home_cfg -> $cfg"
                fi

                next_tokens=$(mktemp)
                jq --arg agent "$user" --arg token "$token" '. + {($agent): $token}' "$tmp_tokens" > "$next_tokens"
                mv "$next_tokens" "$tmp_tokens"

                if [ "$changed" -eq 1 ]; then
                    [ -n "$uid" ] || uid=$(id -u "$user" 2>/dev/null || true)
                    if [ -n "$uid" ]; then
                        if sudo -n -u "$user" \
                            env XDG_RUNTIME_DIR="/run/user/$uid" \
                                DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
                            systemctl --user restart openclaw-gateway.service 2>/dev/null; then
                            ok "  $user: restarted openclaw-gateway.service for hook config"
                        else
                            warn "  $user: hook config changed; restart openclaw-gateway.service manually if it is already running"
                        fi
                    fi
                fi
            done < <(jq -r '
                .agents[]
                | select(.enabled == true)
                | . as $a
                | ($a.listeners // [] | map(select(.owner == "openclaw-gateway")) | .[0].port // empty) as $port
                | select($port != "")
                | "\($a.user)\t\($a.uid // "")\t\($port)\t\($a.home // "")"
            ' "$REGISTRY")
        else
            warn "  registry or jq unavailable; $PM_CONSUMER_TOKEN_FILE remains an empty/preserved token map"
        fi

        install -o root -g "$pm_group" -m 0640 "$tmp_tokens" "$PM_CONSUMER_TOKEN_FILE"
        rm -f "$tmp_tokens"
        ok "$PM_CONSUMER_TOKEN_FILE"

        if [ ! -f "$PM_OPENCLAW_CHANNEL_TOKEN_FILE" ]; then
            tmp_channel_tokens=$(mktemp)
            printf '{}\n' > "$tmp_channel_tokens"
            install -o root -g "$PM_OPENCLAW_CHANNEL_TOKEN_GROUP" -m 0640 "$tmp_channel_tokens" "$PM_OPENCLAW_CHANNEL_TOKEN_FILE"
            rm -f "$tmp_channel_tokens"
        else
            chown "root:$PM_OPENCLAW_CHANNEL_TOKEN_GROUP" "$PM_OPENCLAW_CHANNEL_TOKEN_FILE" 2>/dev/null || true
            chmod 0640 "$PM_OPENCLAW_CHANNEL_TOKEN_FILE" 2>/dev/null || true
        fi
        ok "$PM_OPENCLAW_CHANNEL_TOKEN_FILE"

        if [ -f "$pm_unit_src" ]; then
            tmp_unit=$(mktemp)
            sed -e "s|^User=.*|User=$pm_app_user|" \
                -e "s|^Group=.*|Group=$pm_app_group|" \
                -e "s|^WorkingDirectory=.*|WorkingDirectory=$PM_WEB_ROOT/.next/standalone|" \
                -e "s|^EnvironmentFile=.*|EnvironmentFile=$PM_ENV_FILE|" \
                -e "s|^Environment=PM_OPENCLAW_CHANNEL_TOKEN_FILE=.*|Environment=PM_OPENCLAW_CHANNEL_TOKEN_FILE=$PM_OPENCLAW_CHANNEL_TOKEN_FILE|" \
                -e "s|^ExecStart=.*|ExecStart=$PM_NODE_BIN server.js|" \
                -e "s|^ReadWritePaths=.*|ReadWritePaths=$PM_WEB_ROOT/prisma $PM_WEB_ROOT/.data $PM_AGENT_CREDENTIALS_DIR $PM_DROP_DIR /srv/agents/openclaw /srv/agents/Pictures -$PM_ATTACHMENT_ROOT -$PM_SAMBA_SHARED_ROOT -${PM_AGENT_PROVISION_DIR:-/var/lib/pm/agent-provision} -/var/lib/worktree-switch|" \
                -e "s|^ReadOnlyPaths=.*|ReadOnlyPaths=/srv/agents $PM_OPENCLAW_CHANNEL_TOKEN_FILE|" \
                "$pm_unit_src" > "$tmp_unit"
            install -o root -g root -m 0644 "$tmp_unit" /etc/systemd/system/pm.service
            rm -f "$tmp_unit"
            ok "/etc/systemd/system/pm.service"
        else
            warn "  missing $pm_unit_src; skipping pm.service"
        fi

        if [ -f "$consumer_unit_src" ]; then
            tmp_unit=$(mktemp)
            sed -e "s|^User=.*|User=$pm_user|" \
                -e "s|^Group=.*|Group=$pm_group|" \
                -e "s|^WorkingDirectory=.*|WorkingDirectory=$PM_WEB_ROOT|" \
                -e "s|^EnvironmentFile=.*|EnvironmentFile=$PM_ENV_FILE|" \
                -e "s|^Environment=PM_CONSUMER_DROP_DIR=.*|Environment=PM_CONSUMER_DROP_DIR=$PM_DROP_DIR|" \
                -e "s|^Environment=PM_CONSUMER_HOOK_TOKEN_FILE=.*|Environment=PM_CONSUMER_HOOK_TOKEN_FILE=$PM_CONSUMER_TOKEN_FILE|" \
                -e "s|^Environment=HOME=.*|Environment=HOME=$PM_CONSUMER_PNPM_HOME|" \
                -e "s|^Environment=XDG_CONFIG_HOME=.*|Environment=XDG_CONFIG_HOME=$PM_CONSUMER_PNPM_CONFIG_HOME|" \
                -e "s|^Environment=XDG_CACHE_HOME=.*|Environment=XDG_CACHE_HOME=$PM_CONSUMER_PNPM_CACHE_HOME|" \
                -e "s|^Environment=PNPM_HOME=.*|Environment=PNPM_HOME=$PM_CONSUMER_PNPM_HOME|" \
                -e "s|^Environment=NPM_CONFIG_USERCONFIG=.*|Environment=NPM_CONFIG_USERCONFIG=$PM_CONSUMER_PNPM_HOME/.npmrc|" \
                -e "s|^Environment=npm_config_userconfig=.*|Environment=npm_config_userconfig=$PM_CONSUMER_PNPM_HOME/.npmrc|" \
                -e "s|^ExecStart=.*|ExecStart=$PM_PNPM_BIN pm-consumer|" \
                -e "s|^ReadWritePaths=.*|ReadWritePaths=$PM_WEB_ROOT/prisma $PM_DROP_DIR $PM_CONSUMER_PNPM_HOME $PM_CONSUMER_PNPM_CONFIG_HOME $PM_CONSUMER_PNPM_CACHE_HOME|" \
                "$consumer_unit_src" > "$tmp_unit"
            install -o root -g root -m 0644 "$tmp_unit" /etc/systemd/system/pm-consumer.service
            rm -f "$tmp_unit"
            ok "/etc/systemd/system/pm-consumer.service"
        else
            warn "  missing $consumer_unit_src; skipping pm-consumer.service"
        fi

        if [ -f "$channel_installer" ]; then
            if [ -x "$PM_NODE_BIN" ]; then
                log "  native PM channel final callback: $PM_OPENCLAW_CHANNEL_CALLBACK_URL"
                log "  native PM channel stream callback is supplied per turn by the PM app; no-reply turns fail visibly instead of completing on bare done"
                channel_args=(
                    --registry "$REGISTRY"
                    --agent-root "$pm_channel_agent_root"
                    --token-file "$PM_OPENCLAW_CHANNEL_TOKEN_FILE"
                    --token-group "$PM_OPENCLAW_CHANNEL_TOKEN_GROUP"
                    --callback-url "$PM_OPENCLAW_CHANNEL_CALLBACK_URL"
                    --restart
                )
                if [ -n "$pm_channel_agents" ]; then
                    channel_args+=(--agents "$pm_channel_agents")
                fi
                PM_OPENCLAW_CHANNEL_TOKEN_FILE="$PM_OPENCLAW_CHANNEL_TOKEN_FILE" \
                PM_OPENCLAW_CHANNEL_TOKEN_GROUP="$PM_OPENCLAW_CHANNEL_TOKEN_GROUP" \
                "$PM_NODE_BIN" "$channel_installer" "${channel_args[@]}" \
                    || warn "  native PM channel installer failed (continuing)"
            else
                warn "  node not found/executable at $PM_NODE_BIN; skipping native PM channel installer"
            fi
        else
            warn "  missing $channel_installer; skipping native PM channel installer"
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
    systemctl enable --now openclaw-agent-runner.service 2>/dev/null \
        && ok "openclaw-agent-runner.service enabled + started" \
        || warn "  could not enable/start openclaw-agent-runner.service (continuing)"
    for u in agent-dashboard.service \
             pm.service \
             pm-consumer.service \
             ai-monitor.timer \
             openclaw-integrity.timer \
             openclaw-backup.timer \
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
    DERIVE=$(jq -r --slurpfile defs "$DEFAULTS" '
      any(.agents[]; .enabled == true and .role == "coding" and .integrations.jira == true) as $has_jira |
      any(.agents[]; .enabled == true and .role == "coding" and .integrations.bitbucket == true) as $has_bb |
      .agents[] | select(.enabled == true) | . as $a |
      (($defs[0].core.services // []) +
       (($defs[0].byRole[$a.role].services // [])) +
       ([ ($a.integrations // {}) | to_entries[]
          | select(.value == true)
          | $defs[0].byIntegration[.key].services // [] ] | add // []) +
       ($a.services // []))
      | unique
      | map(select(startswith("openclaw-")))
      | map(select(. != "openclaw-jira-receiver.service" or $has_jira))
      | map(select(. != "openclaw-bitbucket-receiver.service" or $has_bb))
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
log "jira-receiver, bitbucket-receiver) are reconciled"
log "automatically by step [7/7] above based on each agent's derived service set."
