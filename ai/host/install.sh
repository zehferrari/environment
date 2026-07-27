#!/bin/bash
# Install thinkpad-specific operating-system configuration from this worktree.

set -euo pipefail

DRY_RUN=0
case "${1:-}" in
    "") ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
        printf 'Usage: %s [--dry-run]\n' "$0"
        exit 0
        ;;
    *)
        printf 'Unknown argument: %s\n' "$1" >&2
        exit 2
        ;;
esac

HOST_ROOT="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="${OPENCLAW_AGENTS_JSON:-/etc/openclaw/agents.json}"
KERNEL_CMDLINE="${KERNEL_CMDLINE:-/etc/kernel/cmdline}"
OPENCLAW_BIN="${OPENCLAW_BIN:-/usr/local/bin/openclaw}"

if [ "$DRY_RUN" -eq 0 ] && [ "$EUID" -ne 0 ]; then
    printf 'Run as root, or use --dry-run to preview.\n' >&2
    exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
    printf 'Required command is missing: jq\n' >&2
    exit 1
fi
if [ ! -s "$REGISTRY" ] || ! jq -e '
    (.agents | type == "array") and
    all(
        .agents[] | select(.enabled == true);
        (.user | type == "string" and length > 0) and
        (.uid | type == "number" and . >= 1001)
    )
' "$REGISTRY" >/dev/null; then
    printf 'Agent registry is missing or invalid: %s\n' "$REGISTRY" >&2
    exit 1
fi
if ! ENABLED_AGENT_TSV="$(jq -r '
    .agents[]
    | select(.enabled == true)
    | "\(.user)\t\(.uid)"
' "$REGISTRY")"; then
    printf 'Could not snapshot enabled agents from registry: %s\n' \
        "$REGISTRY" >&2
    exit 1
fi
if [ ! -s "$KERNEL_CMDLINE" ]; then
    printf 'Refusing to create or replace an empty kernel command line: %s\n' \
        "$KERNEL_CMDLINE" >&2
    exit 1
fi
if [ "$DRY_RUN" -eq 0 ] && [ ! -x "$OPENCLAW_BIN" ]; then
    printf 'OpenClaw executable is missing: %s\n' "$OPENCLAW_BIN" >&2
    exit 1
fi

# Reject malformed units or a logrotate stanza that cannot traverse the live
# nginx log directory before replacing any host configuration. Dry-run remains
# usable without root/systemd access and describes these checks instead.
if [ "$DRY_RUN" -eq 0 ]; then
    systemd-analyze verify \
        "$HOST_ROOT/systemd/zypper-dup.service" \
        "$HOST_ROOT/systemd/zypper-dup.timer"
    # Shared worktrees are intentionally group-writable. logrotate refuses to
    # parse a group-writable config even in debug mode, so validate a root-only
    # temporary copy matching the installed file's final ownership/mode.
    logrotate_check="$(mktemp)"
    trap 'rm -f "$logrotate_check"' EXIT
    install -o root -g root -m 0644 "$HOST_ROOT/logrotate/nginx" "$logrotate_check"
    /usr/sbin/logrotate --debug --state /dev/null "$logrotate_check"
    rm -f "$logrotate_check"
    trap - EXIT

    # logrotate --debug parses and plans the rotation but does not perform the
    # target-user filesystem operations. Verify the configured `su zeh zeh`
    # identity can traverse and modify the directory and read every live log.
    if [ -d /var/log/nginx ]; then
        runuser -u zeh -- test -x /var/log/nginx
        runuser -u zeh -- test -w /var/log/nginx
        for nginx_log in /var/log/nginx/*.log; do
            [ -e "$nginx_log" ] || continue
            runuser -u zeh -- test -r "$nginx_log"
        done
    else
        printf 'error: live nginx log directory is missing: /var/log/nginx\n' >&2
        exit 1
    fi
fi

install_managed_file() {
    local mode="$1" source="$2" destination="$3"
    if [ "$DRY_RUN" -eq 1 ]; then
        printf 'would install -m %s %s -> %s\n' "$mode" "$source" "$destination"
        return
    fi

    install -d -o root -g root -m 0755 "$(dirname "$destination")"
    install -o root -g root -m "$mode" "$source" "$destination"
    printf 'installed %s\n' "$destination"
}

install_managed_file 0644 \
    "$HOST_ROOT/tlp/30-charge-thresholds.conf" \
    /etc/tlp.d/30-charge-thresholds.conf
install_managed_file 0644 \
    "$HOST_ROOT/logrotate/nginx" \
    /etc/logrotate.d/nginx
install_managed_file 0644 \
    "$HOST_ROOT/systemd/zypper-dup.service" \
    /etc/systemd/system/zypper-dup.service
install_managed_file 0644 \
    "$HOST_ROOT/systemd/zypper-dup.timer" \
    /etc/systemd/system/zypper-dup.timer
install_managed_file 0644 \
    "$HOST_ROOT/tmpfiles/fs-tmp.conf" \
    /etc/tmpfiles.d/fs-tmp.conf
install_managed_file 0644 \
    "$HOST_ROOT/systemd/user/openclaw-gateway.service.d/30-memory-policy.conf" \
    /etc/systemd/user/openclaw-gateway.service.d/30-memory-policy.conf

install_agent_user_manager_delegation() {
    local user uid
    local -A expected_uids=()
    while IFS=$'\t' read -r user uid; do
        [ -n "$uid" ] || continue
        expected_uids["$uid"]=1
        install_managed_file 0644 \
            "$HOST_ROOT/systemd/user-manager/80-openclaw-resource-controllers.conf" \
            "/etc/systemd/system/user@$uid.service.d/80-openclaw-resource-controllers.conf"
    done <<< "$ENABLED_AGENT_TSV"

    # Remove only this installer's exact managed filename for users no longer
    # enabled in the canonical registry. Preserve every unrelated drop-in.
    local managed directory stale_uid
    shopt -s nullglob
    for managed in \
        /etc/systemd/system/user@*.service.d/80-openclaw-resource-controllers.conf
    do
        directory="$(dirname "$managed")"
        stale_uid="${directory##*/user@}"
        stale_uid="${stale_uid%.service.d}"
        if [ -n "${expected_uids[$stale_uid]:-}" ]; then
            continue
        fi
        if [ "$DRY_RUN" -eq 1 ]; then
            printf 'would remove stale managed delegation %s\n' "$managed"
            continue
        fi
        rm -f "$managed"
        rmdir "$directory" 2>/dev/null || true
        printf 'removed stale managed delegation for uid %s\n' "$stale_uid"
    done
    shopt -u nullglob
}

install_agent_user_manager_delegation

merge_kernel_option() {
    local required="$1"
    local key="${required%%=*}"
    local temporary owner group mode
    if [ "$DRY_RUN" -eq 1 ]; then
        temporary="$(mktemp)"
    else
        temporary="$(mktemp "${KERNEL_CMDLINE}.tmp.XXXXXX")"
    fi

    # Preserve comments, unrelated lines, and existing whitespace. Rebuild only
    # a line that contains this option, replace its first occurrence, remove
    # duplicates, or append the option on its own line when absent.
    awk -v key="$key" -v required="$required" '
        function is_target(token) {
            return token == key || index(token, key "=") == 1
        }
        BEGIN { seen = 0 }
        /^[[:space:]]*#/ { print; next }
        {
            target_on_line = 0
            for (i = 1; i <= NF; i++) {
                if ($i ~ /^#/) break
                if (is_target($i)) target_on_line = 1
            }
            if (!target_on_line) {
                print
                next
            }

            output = ""
            for (i = 1; i <= NF; i++) {
                token = $i
                if (token ~ /^#/) {
                    for (j = i; j <= NF; j++) {
                        output = output (output == "" ? "" : " ") $j
                    }
                    break
                }
                if (is_target(token)) {
                    if (seen) continue
                    token = required
                    seen = 1
                }
                output = output (output == "" ? "" : " ") token
            }
            print output
        }
        END {
            if (!seen) print required
        }
    ' "$KERNEL_CMDLINE" > "$temporary"

    if cmp -s "$KERNEL_CMDLINE" "$temporary"; then
        rm -f "$temporary"
        printf 'kernel option already active in persistent config: %s\n' "$required"
        return
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
        rm -f "$temporary"
        printf 'would merge kernel option %s into %s\n' "$required" "$KERNEL_CMDLINE"
        return
    fi

    owner="$(stat -c '%U' "$KERNEL_CMDLINE")"
    group="$(stat -c '%G' "$KERNEL_CMDLINE")"
    mode="$(stat -c '%a' "$KERNEL_CMDLINE")"
    chown "$owner:$group" "$temporary"
    chmod "$mode" "$temporary"
    mv -f "$temporary" "$KERNEL_CMDLINE"
    printf 'merged kernel option %s into %s\n' "$required" "$KERNEL_CMDLINE"
}

while IFS= read -r option; do
    case "$option" in
        ""|\#*) continue ;;
    esac
    merge_kernel_option "$option"
done < "$HOST_ROOT/kernel/required-cmdline"

# Always refresh all managed entries after reconciling the persistent command
# line. This is intentionally idempotent: if a prior installer was interrupted
# after writing /etc/kernel/cmdline, the next run must still repair boot entries.
if [ "$DRY_RUN" -eq 0 ]; then
    sdbootutil update-all-entries
    printf 'refreshed systemd-boot entries; psi=1 takes effect after reboot\n'
fi

apply_gateway_diagnostics_policy() {
    local user uid config temporary owner group mode
    while IFS=$'\t' read -r user uid; do
        [ -n "$user" ] || continue
        config="/srv/agents/openclaw/$user/openclaw.json"
        if [ ! -f "$config" ]; then
            printf 'error: gateway config missing for %s: %s\n' \
                "$user" "$config" >&2
            return 1
        fi
        if jq -e '.diagnostics.memoryPressureSnapshot == true' "$config" >/dev/null 2>&1; then
            printf 'gateway diagnostics already enabled for %s\n' "$user"
            continue
        fi
        if [ "$DRY_RUN" -eq 1 ]; then
            printf 'would enable diagnostics.memoryPressureSnapshot for %s\n' "$user"
            continue
        fi

        # Build and validate beside the canonical file so the final rename is
        # atomic for the running gateway's config watcher.
        temporary="$(mktemp "${config}.tmp.XXXXXX")"
        jq '.diagnostics = ((.diagnostics // {}) + {memoryPressureSnapshot: true})' \
            "$config" > "$temporary"
        if ! env "HOME=/home/$user" "OPENCLAW_CONFIG_PATH=$temporary" \
            "$OPENCLAW_BIN" config validate --json >/dev/null; then
            rm -f "$temporary"
            printf 'error: refusing invalid OpenClaw config update for %s\n' "$user" >&2
            return 1
        fi
        owner="$(stat -c '%U' "$config")"
        group="$(stat -c '%G' "$config")"
        mode="$(stat -c '%a' "$config")"
        chown "$owner:$group" "$temporary"
        chmod "$mode" "$temporary"
        mv -f "$temporary" "$config"
        printf 'enabled gateway memory-pressure snapshots for %s\n' "$user"
    done <<< "$ENABLED_AGENT_TSV"
}

reconcile_gateway_config_links() {
    local user uid config home_config temporary resolved
    while IFS=$'\t' read -r user uid; do
        [ -n "$user" ] || continue
        config="/srv/agents/openclaw/$user/openclaw.json"
        home_config="/home/$user/.openclaw/openclaw.json"
        resolved="$(readlink -f "$home_config" 2>/dev/null || true)"
        if [ -L "$home_config" ] && [ "$resolved" = "$config" ]; then
            printf 'gateway config link already canonical for %s\n' "$user"
            continue
        fi
        if [ -e "$home_config" ] && ! cmp -s "$config" "$home_config"; then
            printf 'error: refusing to replace divergent home gateway config for %s: %s\n' \
                "$user" "$home_config" >&2
            return 1
        fi
        if [ "$DRY_RUN" -eq 1 ]; then
            printf 'would link %s -> %s\n' "$home_config" "$config"
            continue
        fi

        # Publish a same-directory symlink atomically so a running config
        # watcher never observes a missing path. A regular file is replaced
        # only after the byte-for-byte comparison above succeeds.
        temporary="${home_config}.tmp.$$"
        ln -s "$config" "$temporary"
        chown -h "$user:$user" "$temporary"
        mv -Tf "$temporary" "$home_config"
        printf 'linked canonical gateway config for %s\n' "$user"
    done <<< "$ENABLED_AGENT_TSV"
}

reload_gateway_user_managers() {
    local user uid
    while IFS=$'\t' read -r user uid; do
        [ -n "$user" ] && [ -n "$uid" ] || continue
        if [ "$DRY_RUN" -eq 1 ]; then
            printf 'would daemon-reload user systemd for %s\n' "$user"
            continue
        fi
        if sudo -n -u "$user" \
            env "XDG_RUNTIME_DIR=/run/user/$uid" \
                "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus" \
            systemctl --user daemon-reload; then
            printf 'reloaded user systemd for %s\n' "$user"
        else
            printf 'warning: could not reload user systemd for %s\n' "$user" >&2
        fi
    done <<< "$ENABLED_AGENT_TSV"
}

apply_gateway_diagnostics_policy
reconcile_gateway_config_links

if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s\n' \
        'would validate the systemd units and nginx logrotate permissions' \
        'would reload systemd' \
        'would idempotently refresh all systemd-boot entries' \
        'would daemon-reload systemd for each enabled agent (gateway restart remains explicit)' \
        'would enable and apply tlp.service' \
        'would enable and start zypper-dup.timer (not zypper-dup.service)' \
        'would clear old failed state for logrotate, zypper, backup, and ai-monitor'
    exit 0
fi

systemctl daemon-reload
reload_gateway_user_managers
systemctl enable tlp.service zypper-dup.timer
systemctl restart tlp.service
systemctl start zypper-dup.timer

systemctl reset-failed \
    logrotate.service \
    zypper-dup.service \
    openclaw-backup.service \
    ai-monitor.service

printf '%s\n' \
    'thinkpad host configuration installed.' \
    'Verify with: tlp-stat -s -p; systemctl status tlp.service zypper-dup.timer; systemctl --failed'
