# Sudoers templates for OpenClaw

These are **reference templates** for the sudoers files the OpenClaw stack
needs. Most are generated at runtime by `openclaw-manage-user` from the
live registry; the ones here are the static/hand-installed fragments that
`install.sh` does not auto-lay-down (sudoers are hand-reviewed per the
`install.sh` header comment).

| File | Generated? | Installed at | Purpose |
|---|---|---|---|
| `monitor-openclaw-control.in` | Yes (by `openclaw-manage-user::regenerate_monitor_sudoers`) | `/etc/sudoers.d/<monitor>-openclaw-control` | Monitor agent's full sudo grant: `openclaw-control`, `openclaw-manage-user`, `install.sh`, systemctl restart, journalctl, read-only fs inspection. **This template is for reference only** — the live file is generated from the registry + `$REPO_ROOT`. |
| `openclaw-mail-self-wake.in` | Yes (by `openclaw-manage-user` step 5, as `openclaw-wake-<user>`) | `/etc/sudoers.d/openclaw-wake-<user>` (one per coding agent) | Lets each coding agent run `openclaw-control wake-agent <self>` without a password. Generated per-agent during `add`/`update`. |
| `openclaw-agent-anotheragent` | No (static) | `/etc/sudoers.d/openclaw-agent-anotheragent` | Cross-agent wake grant. Hand-installed when one agent needs to wake another. |
| `pm-monitor-wake-agent` | No (static) | `/etc/sudoers.d/pm-monitor-wake-agent` | Lets a coding agent call the monitor's degraded-fallback wake helper (`pm-monitor-wake-agent`). Hand-installed. |

## Install

`install.sh` does **not** install sudoers automatically (they're
hand-reviewed). To bootstrap on a fresh host:

1. Run `openclaw-manage-user add <monitor-user> <uid> monitor` once as
   root — this generates `/etc/sudoers.d/<monitor>-openclaw-control`
   from the registry.
2. Run `openclaw-manage-user add <coding-user> <uid> coding` for each
   coding agent — this generates
   `/etc/sudoers.d/openclaw-wake-<coding-user>`.
3. Hand-install the static fragments (`openclaw-agent-anotheragent`,
   `pm-monitor-wake-agent`) if your host needs them, substituting the
   real agent usernames.
4. Validate with `sudo visudo -c`.

The PM worktree-switcher sudoers (`pm-switch`) lives at
`ai/web/deploy/sudoers.d/pm-switch` and is installed by
`install-pm-switch.sh`.