# Monitoring

The monitoring agent runs under Linux user `karen`. Identity, capabilities, and
Telegram bot handle live in `/etc/openclaw/agents.json`.

For full architecture (triage flow, decision contract, fallback rules,
self-incident guard), see [`../README.md`](../README.md) § *Monitoring and Recovery*. This file is
the entry-point overview.

## What gets watched

- **System timers** (`/usr/local/bin/`):
  - `openclaw-integrity-check` — every 2 min via `openclaw-integrity.timer`.
  - `ai-monitor` — every 2 min via `ai-monitor.timer`, offset from
    integrity. Reads the watch list dynamically from
    `/etc/openclaw/agents.json` every tick.
  - `openclaw-backup` — daily at 04:20 (±20 min) via
    `openclaw-backup.timer`. Latest 14 archives kept under
    `/var/backups/openclaw`; off-host copy at
    `moonlight:/srv/backups/openclaw/x1`.
- **Per-agent services** declared under `services` in `agents.json`
  (`openclaw-gateway`, `openclaw-gmail-listener`,
  `openclaw-webhook-receiver`, `wdt-<user>`).
- **Listeners** declared under `listeners` in `agents.json`.
- **Stalled Jira tickets** for any agent with `coding: true` and
  `integrations.jira: true`. Two complementary kinds: `task-stalled-no-agent`
  (primary, defined by *most-recent activity* — max of newest openclaw
  session-jsonl mtime AND `updatedAt` across all `agent:main:*` keys in
  `~/.openclaw/agents/main/sessions/sessions.json`; the second source covers
  `claude-cli` provider sessions where openclaw never writes its own jsonl,
  and activity on non-heartbeat surfaces like Telegram DMs / subagents) and
  `task-stalled-no-progress` (secondary, defined by Jira `updated` field).
- **Pending @-mentions** in `/var/lib/ai-monitor/pending-mentions/`. The
  webhook receiver writes a marker per mention; ai-monitor's
  `probe_pending_mentions` resolves on agent reply or fires
  `mention-awaiting-reply` warn (≥15 min) / crit (≥60 min).
- **Idle agent with non-empty queue** for any coding agent. `probe_agent_queue`
  fires `agent-idle-with-queue` when an agent has zero tickets In Progress
  but ≥1 in any of the configured `queue_statuses` (default
  `["Selected for Development", "To Do"]`) AND their session has been
  idle past threshold (default warn 10 min / crit 30 min, configurable
  under `agent_queue_check`). Closes the gap `task-stalled-no-agent`
  cannot see (after a ticket transitions out of In Progress, that probe
  loses the attachment point). Handled deterministically by ai-monitor —
  bypasses Karen entirely (see `karen_triage.auto_action_kinds_bypass_karen`)
  and runs `openclaw-control wake-agent <user>` directly with a reminder
  naming the queued ticket keys and referencing TEAM_WORKFLOW.md
  *"Picking the Next Task"*. Rationale: situation is unambiguous and the
  action is bounded; no triage judgment needed.

## Registry-driven

The registry (`agents.json`) is the source for what to monitor:

- `monitor: true` — included in checks.
- `services` — user systemd services expected active.
- `listeners` — expected TCP listeners.
- `integrations` — controls deeper checks (Gmail, Jira, Bitbucket).
- `capabilities` — declares what the monitoring agent may do (and may not).

`/home/karen/webhooks/users.json` is webhook routing only, **not** the
agent roster. Don't conflate them.

Validate drift after any registry/service edit:

```
/usr/local/bin/openclaw-registry-check          # static checks
/usr/local/bin/openclaw-registry-check --runtime # also services + ports
/usr/local/bin/openclaw-boot-readiness           # full post-reboot check
```

## Notifications

`/etc/ai-monitor/config.json` routes alerts through the monitoring agent.
Telegram bot, secrets, and chat allowlist are per-agent — see the registry
(`telegram.bot` for the `karen` user), `~/.config/openclaw/openclaw-secrets.env`,
and `~/.openclaw/credentials/telegram-allowFrom.json`.

## Dashboard

Read-only, real-time, basic-auth-gated:

- URL: `https://dev.vixi.au/agents.html`
- Backend: `agent-dashboard.service` on `127.0.0.1:3013` (HTTP + SSE),
  registry hydration via `/agents/registry.json`.
- Architecture detail: [`../README.md`](../README.md) § *Agent Dashboard*.

## Known risks

- x1 is a **single point of failure** for agents, monitoring, WDT
  playgrounds, and remediation. Disk-loss risk is bounded only as long as
  off-host backup stays current.
- **Gmail watches expire** and must keep renewing successfully.
- **Self-incidents** (issues affecting `karen` or `ai-monitor` itself) bypass
  the triage handoff and go to direct Telegram — the monitoring agent can't
  safely triage its own outage.
- **Per-user secret split** is correct for least privilege but makes audits
  dependent on `/usr/local/bin/openclaw-backup --inventory` plus
  `openclaw-registry-check`.
- **Documentation drift** is possible if future changes bypass the registry
  and shared docs.
