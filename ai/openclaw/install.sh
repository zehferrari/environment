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
#   5. reconcile per-agent private files under the host agent-files root
#   6. symlink the frontend HTML for agent-dashboard
#   7. systemctl daemon-reload (system + per-user) + restart running units
#   8. reconcile per-agent user-systemd state against the derived services
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
AGENT_FILES_ROOT="${OPENCLAW_AGENT_FILES_ROOT:-}"

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

clone_dir_permissions() {
    local src="$1" dst="$2"
    if [ ! -d "$src" ] || [ ! -d "$dst" ]; then
        return
    fi
    if [ "$DRY" -eq 1 ]; then
        log "  would clone permissions $src → $dst"
        return
    fi
    chown "$(stat -c '%U:%G' "$src")" "$dst" 2>/dev/null || true
    chmod --reference="$src" "$dst" 2>/dev/null || true
    if command -v getfacl >/dev/null 2>&1 && command -v setfacl >/dev/null 2>&1; then
        getfacl --omit-header "$src" 2>/dev/null | setfacl --set-file=- "$dst" 2>/dev/null || true
    fi
}

set_agent_config_permissions() {
    local user="$1" group="$2" mode="$3" path="$4"
    [ -e "$path" ] || return
    chown "$user:$group" "$path" 2>/dev/null || true
    chmod "$mode" "$path" 2>/dev/null || true
    if command -v setfacl >/dev/null 2>&1 && [ "$mode" = "0660" ]; then
        setfacl -m "u:$user:rw-,g:$group:rw-,m::rw-,o::---" "$path" 2>/dev/null || true
    fi
}

# 1. bin scripts
log "[1/8] bin scripts"
do_install 755 "$REPO_ROOT/bin/ai-monitor"                /usr/local/bin/ai-monitor
do_install 755 "$REPO_ROOT/bin/openclaw-integrity-check"  /usr/local/bin/openclaw-integrity-check
do_install 755 "$REPO_ROOT/bin/openclaw-control"          /usr/local/sbin/openclaw-control
do_install 755 "$REPO_ROOT/bin/agent-dashboard"           /usr/local/bin/agent-dashboard
do_install 755 "$REPO_ROOT/bin/openclaw-monitor-sync"     /usr/local/sbin/openclaw-monitor-sync
do_install 755 "$REPO_ROOT/bin/openclaw-typing-keepalive" /usr/local/bin/openclaw-typing-keepalive
do_install 755 "$REPO_ROOT/bin/gmail-watch-renew-all"     /usr/local/sbin/gmail-watch-renew-all

# 2. system-wide systemd units (host-portable)
log "[2/8] systemd system units"
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
log "[3/8] systemd user units (admin-installed, system-wide visible)"
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
log "[4/8] generate openclaw-monitor-sync.path from $REGISTRY"
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
log "[4b/8] webhook scripts → monitor agent home"
if [ -d "$REPO_ROOT/webhooks" ] && [ -r "$REGISTRY" ] && command -v jq >/dev/null 2>&1; then
    MONITOR_LINE=$(jq -r '.agents[] | select(.role == "monitor" and .enabled == true) | "\(.user)\t\(.home // "/home/\(.user)")"' "$REGISTRY" | head -1)
    if [ -n "$MONITOR_LINE" ]; then
        m_user=$(echo "$MONITOR_LINE" | cut -f1)
        m_home=$(echo "$MONITOR_LINE" | cut -f2)
        dst="$m_home/webhooks"
        if [ "$DRY" -eq 1 ]; then
            log "  would install webhooks/*.js → $dst/ (owner=$m_user)"
        else
            install -d -o "$m_user" -g "$m_user" -m 0775 /var/lib/ai-monitor/pending-mentions
            install -d -o "$m_user" -g "$m_user" -m 0775 /var/lib/ai-monitor/pending-assignee-comments
            install -d -o "$m_user" -g "$m_user" -m 0775 /var/lib/ai-monitor/pending-epic-comments
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
log "[4c/8] agent-self.js symlinks per agent"
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
log "[4d/8] codeRoot drift check + per-agent git identity"
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
        #       to that single identity (e.g. x1: gitName="Zeh Ferrari").
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
log "[4e/8] sync gmail helpers to each gmail-integrated coding agent"
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

# 5. per-agent private files
#
# SOUL/USER/MEMORY/IDENTITY/TOOLS/HEARTBEAT and openclaw.json are private
# per-agent content, not repo-owned shared docs. Keep the canonical copies
# under a host-level agent-files root (default: /srv/agents/openclaw,
# overrideable by agents.json agentFilesRoot or OPENCLAW_AGENT_FILES_ROOT),
# and leave symlinks in the paths the runtime already reads.
log "[5/8] per-agent private files root"
if [ -r "$REGISTRY" ] && command -v jq >/dev/null 2>&1; then
    if [ -z "$AGENT_FILES_ROOT" ]; then
        AGENT_FILES_ROOT=$(jq -r '.agentFilesRoot // "/srv/agents/openclaw"' "$REGISTRY")
    fi
    CODE_ROOT_FOR_PERMS=$(jq -r '.codeRoot // empty' "$REGISTRY")
    CODE_GROUP_FOR_AGENT_FILES=$(jq -r '.codeGroup // empty' "$REGISTRY")
    AGENT_FILES_PARENT=$(dirname "$AGENT_FILES_ROOT")
    PRIVATE_FILES="SOUL.md USER.md MEMORY.md IDENTITY.md TOOLS.md HEARTBEAT.md"
    PRIVATE_CONFIG="openclaw.json"

    if [ "$DRY" -eq 1 ]; then
        log "  would create $AGENT_FILES_ROOT"
        [ -n "$CODE_ROOT_FOR_PERMS" ] && log "  would replicate $CODE_ROOT_FOR_PERMS permissions on $AGENT_FILES_PARENT and $AGENT_FILES_ROOT"
    else
        mkdir -p "$AGENT_FILES_ROOT"
        if [ -n "$CODE_ROOT_FOR_PERMS" ] && [ -d "$CODE_ROOT_FOR_PERMS" ]; then
            clone_dir_permissions "$CODE_ROOT_FOR_PERMS" "$AGENT_FILES_PARENT"
            clone_dir_permissions "$CODE_ROOT_FOR_PERMS" "$AGENT_FILES_ROOT"
        fi
    fi

    while IFS=$'\t' read -r u h workspace; do
        [ -z "$u" ] && continue
        home="${h:-/home/$u}"
        primary_workspace="${workspace:-$home/workspace}"
        openclaw_workspace="$home/.openclaw/workspace"
        dst_dir="$AGENT_FILES_ROOT/$u"

        if [ -n "$CODE_GROUP_FOR_AGENT_FILES" ] && getent group "$CODE_GROUP_FOR_AGENT_FILES" >/dev/null 2>&1; then
            dst_group="$CODE_GROUP_FOR_AGENT_FILES"
            config_mode=0660
        else
            dst_group="$(id -gn "$u" 2>/dev/null || printf '%s' "$u")"
            config_mode=0600
        fi

        if [ "$DRY" -eq 1 ]; then
            log "  would create $dst_dir (owner=$u group=$dst_group)"
        else
            install -d -o "$u" -g "$dst_group" -m 2770 "$dst_dir"
            if command -v setfacl >/dev/null 2>&1; then
                setfacl -m "u:$u:rwx" "$dst_dir" 2>/dev/null || true
                setfacl -d -m "u:$u:rwx" "$dst_dir" 2>/dev/null || true
            fi
        fi

        for f in $PRIVATE_FILES; do
            dst="$dst_dir/$f"
            candidate=""

            for src_dir in "$primary_workspace" "$openclaw_workspace"; do
                [ -d "$src_dir" ] || continue
                src="$src_dir/$f"
                if [ -e "$src" ] && [ ! -L "$src" ]; then
                    candidate="$src"
                    break
                fi
            done

            if [ ! -e "$dst" ] && [ -n "$candidate" ]; then
                if [ "$DRY" -eq 1 ]; then
                    log "    would move $candidate → $dst"
                else
                    mv "$candidate" "$dst"
                    chown "$u:$u" "$dst" 2>/dev/null || true
                    ok "  $u: moved $f to $dst"
                fi
            elif [ -e "$dst" ] && [ -n "$candidate" ]; then
                if cmp -s "$candidate" "$dst" 2>/dev/null; then
                    if [ "$DRY" -eq 1 ]; then
                        log "    would replace duplicate $candidate with symlink"
                    else
                        rm -f "$candidate"
                    fi
                else
                    warn "  $u: $f already exists at $dst and differs from $candidate; leaving source untouched"
                fi
            elif [ ! -e "$dst" ]; then
                log "  $u: $f missing; no canonical file to link"
                continue
            fi

            for src_dir in "$primary_workspace" "$openclaw_workspace"; do
                [ -d "$src_dir" ] || continue
                src="$src_dir/$f"
                if [ -e "$src" ] && [ ! -L "$src" ]; then
                    if cmp -s "$src" "$dst" 2>/dev/null; then
                        if [ "$DRY" -eq 1 ]; then
                            log "    would replace duplicate $src with symlink"
                            continue
                        fi
                        rm -f "$src"
                    else
                        warn "  $u: $src differs from $dst; leaving regular file untouched"
                        continue
                    fi
                fi
                if [ "$DRY" -eq 1 ]; then
                    log "    would symlink $src → $dst"
                else
                    ln -snf "$dst" "$src"
                    chown -h "$u:$u" "$src" 2>/dev/null || true
                fi
            done
        done

        src="$home/.openclaw/$PRIVATE_CONFIG"
        dst="$dst_dir/$PRIVATE_CONFIG"
        if [ ! -e "$dst" ] && [ -e "$src" ] && [ ! -L "$src" ]; then
            if [ "$DRY" -eq 1 ]; then
                log "    would move $src → $dst"
                log "    would symlink $src → $dst"
                continue
            else
                mv "$src" "$dst"
                set_agent_config_permissions "$u" "$dst_group" "$config_mode" "$dst"
                ok "  $u: moved $PRIVATE_CONFIG to $dst"
            fi
        elif [ -e "$dst" ] && [ -e "$src" ] && [ ! -L "$src" ]; then
            if cmp -s "$src" "$dst" 2>/dev/null; then
                if [ "$DRY" -eq 1 ]; then
                    log "    would replace duplicate $src with symlink"
                    log "    would symlink $src → $dst"
                    continue
                else
                    rm -f "$src"
                    set_agent_config_permissions "$u" "$dst_group" "$config_mode" "$dst"
                fi
            else
                warn "  $u: $PRIVATE_CONFIG already exists at $dst and differs from $src; leaving source untouched"
            fi
        elif [ ! -e "$dst" ]; then
            log "  $u: $PRIVATE_CONFIG missing; no canonical file to link"
            continue
        fi

        if [ -e "$src" ] && [ ! -L "$src" ]; then
            if cmp -s "$src" "$dst" 2>/dev/null; then
                if [ "$DRY" -eq 1 ]; then
                    log "    would replace duplicate $src with symlink"
                    continue
                fi
                rm -f "$src"
            else
                warn "  $u: $src differs from $dst; leaving regular file untouched"
                continue
            fi
        fi

        if [ "$DRY" -eq 1 ]; then
            log "    would symlink $src → $dst"
        else
            ln -snf "$dst" "$src"
            chown -h "$u:$u" "$src" 2>/dev/null || true
            set_agent_config_permissions "$u" "$dst_group" "$config_mode" "$dst"
        fi
    done < <(jq -r '.agents[] | "\(.user)\t\(.home // "")\t\(.workspace // "")"' "$REGISTRY")
else
    warn "  registry unreadable or jq unavailable; skipping per-agent private files"
fi

# 6. dashboard frontend symlink
log "[6/8] dashboard frontend symlink"
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

# 7. systemctl daemon-reload + restart running system units
log "[7/8] systemctl daemon-reload (system + per-user)"
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

# 8. per-agent user-systemd reconcile
# For each enabled agent, derive the expected openclaw-*.service set
# (from core + byRole + byIntegration in agent-defaults.json) and:
#   - daemon-reload their user instance (pick up /etc/systemd/user/ changes)
#   - enable+start any expected service not yet active
#   - disable+stop any active openclaw-*.service NOT in the expected set
#     (orphan cleanup — e.g. the legacy openclaw-webhook-receiver.service
#      after the split into jira+bitbucket receivers)
log "[8/8] per-agent user-systemd reconcile"
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
log "automatically by step [8/8] above based on each agent's derived service set."
