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
- **Pending email tasks** for any coding agent with email integration.
  Gmail and local Maildir listeners are the first responders: when an
  allowlisted sender or local email-capable agent sends an actionable request,
  the listener queues the task and immediately wakes the owner through
  `/usr/local/sbin/openclaw-control wake-agent <self>`. `probe_pending_email_tasks`
  is the fallback if that immediate wake does not result in action. It scans
  `~/tasks/current.md` for sections with `Gmail messageId:` and
  `Status: QUEUED`. It fires `email-awaiting-action` at warn 15 min / crit
  60 min, ignores entries older than 24 h, and bypasses Karen so ai-monitor can
  run `wake-agent` directly. The wake reminder tells the agent to process the
  queued email, reply in the original thread when required, include the
  configured signature/runtime model, and update the task status out of
  `QUEUED`.
  Recovery for this kind is task-status based: the wake/restart is not
  considered successful while the same Gmail messageId is still `QUEUED`.
  `openclaw-control` also clears stale non-running `pendingFinalDelivery*`
  state before each wake so CLI system events cannot wedge the next turn.

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

### Tier framework — try twice, telegram on the third

Every alert key gets up to **3 attempts** before zeh is paged. Configured
under `karen_triage.escalation_ladder` in `/etc/ai-monitor/config.json`
(`max_attempts: 3`, `confirmation_window_s: 300`). Two execution paths:

- **Bypass-Karen kinds** (default `agent-idle-with-queue`):
  T1 = `wake-agent`, T2 = `restart-and-wake`, T3 = telegram with attempt history.
  ai-monitor runs the actions itself; Karen is never involved.
- **Karen-bound kinds** (everything else): incident payload now includes
  an `escalation_context` block (`{attempt, max_attempts, is_final,
  prior_attempts, guidance}`). On T1/T2 Karen is told to act and
  `suppress` with `telegram_sent: false`. On T3 Karen is told this is
  the final attempt — act and send Telegram. If Karen punts on T3,
  ai-monitor falls back to telegramming the attempt history itself.

Between tiers, ai-monitor sets `next_attempt_after = now + 300 s` on the
event. New alerts for the same key are silently skipped during the
confirmation window. Recovery (issue stops appearing in next probe sweep)
clears the event silently via `missed_runs` eviction. Per-event state
(`attempts`, `attempt_history`, `next_attempt_after`) is in
`/var/lib/ai-monitor/state.json`.

Karen's playbook (which kind → which fix on which tier) lives at
`INCIDENT_HANDLING.md`. Karen now also has `systemctl restart` permission
for `ollama`, `nginx`, `mariadb`, `php-fpm`, `agent-dashboard`, and
`openclaw-typing-keepalive` (sudoers: `/etc/sudoers.d/karen-openclaw-control`).

### Monitor agent heartbeat hygiene

`openclaw system event --mode now` (the wake mechanism ai-monitor uses to
hand the monitor agent an incident) marks her `agent:main:main` entry's
`pendingFinalDelivery: true` after each turn — openclaw is trying to
deliver the response back to the invoking channel. ai-monitor invokes
via CLI and exits, so there's no channel; openclaw retries ~40 times
then leaves the flag stuck. Subsequent wakes queue behind it and never
start a new turn. (Symptom: the monitor looks "dead" for hours/days —
every incident times out and falls back to direct telegram.)

ai-monitor now clears `pendingFinalDelivery*` fields on the monitor
agent's `agent:main:main` entry at the **start** of every handoff
(`pre-clear`, catches leftover from the prior tick — openclaw flips the
flag ~3-8 s AFTER the monitor finishes, racing with our post-clear) AND
best-effort at the end. Atomic write preserves the agent's owner/mode.
The skip-if-running guard prevents stomping on an in-flight turn. The
monitor agent is identified by `role: "monitor"` in the registry — no
hardcoded user name. To manually clear if needed:
`sudo /usr/local/sbin/openclaw-control restart-and-wake <monitor-user>
"<reason>"` (the user is whatever the registry says — `karen` here).

The same stale-delivery preflight now runs in `openclaw-control` for every
agent before `wake-agent` / `restart-and-wake`. If `agent:main:main` points at
a missing session jsonl and is not running, the stale entry is quarantined so
OpenClaw can create a fresh main turn.

### Transient kinds (probe failures bypass the monitor)

Network/API flakes (curl timeouts, transient Jira slowness, Pub/Sub timeouts)
are not actionable by the monitor agent — restarting a service won't fix
the upstream API hiccup. These kinds skip the monitor entirely and require
**N consecutive ticks**
of the same key being seen before they emit a single rolled-up telegram, then
enter a cooldown window before they can re-fire. Configured under
`karen_triage`:

- `transient_kinds`: list of kinds bypassed (default includes
  `jira-probe-failed`, `agent-queue-probe-failed`,
  `pending-mentions-probe-failed`, `gmail-pubsub-timeout`,
  `gmail-pubsub-failing`, `telegram-network-unreachable`,
  `telegram-unreachable`, `telegram-connection-failing`, `judge-failed`).
- `transient_consecutive_threshold`: minimum consecutive ticks (default 5,
  ≈ 10 min on a 2-min tick) before a transient issue telegrams.
- `transient_cooldown_s`: after telegram, suppress this key for at least
  this many seconds (default 3600 = 1 h) regardless of continued presence.

The counter (`consecutive_seen` per event in `state.json`) increments on every
tick the key is seen and resets when the key is absent (silent eviction). Issue
payloads gain `_transient: true` and `_consecutive_seen` when graduated.

### Self-healing scheduled tasks (no triage needed)

Some "alerts" are predictable token expiries that should be auto-renewed
by cron, not handed to Karen:

- **Gmail watch tokens** expire every 7 days. Renewed daily at 04:00 by
  `gmail-watch-renew.timer` → `gmail-watch-renew.service` →
  `/usr/local/sbin/gmail-watch-renew-all`. The script reads
  `/etc/openclaw/agents.json` and renews for every agent where
  `enabled=true AND integrations.gmail=true`, pulling topic+labels from
  that agent's `~/.openclaw/workspace/google/watch-state.json`. Non-Gmail
  agents (`integrations.gmail=false`) are silently skipped. If this timer
  is healthy you should never see `gmail-watch-expiring` in ai-monitor.

- **Pending @-mentions auto-clear on Done.** `_agent_replied_since` checks
  `statusCategory.key == "done"` (workflow-agnostic across custom Done /
  Closed / Resolved / Shipped names) on every probe; closed tickets drop
  their pending-mention markers immediately. There's also a 7-day max-age
  safety net (`pending_mentions.max_age_hours`, default 168) so a stuck
  marker on a deleted-without-being-closed issue can't keep alerting forever.

### Busy vs stalled

ai-monitor's `probe_busy_state(user, home)` distinguishes "mid-turn,
doing real work" from "idle/wedged" via three OR'd signals: (1) any
`agent:main:*` key in `sessions.json` with `status='running'` and
`updatedAt` within the last 30 min (excludes leaked status from old
crashed subagents); (2) claude-cli's own jsonl mtime within the last
60 s (covers non-streaming claude-cli turns); (3) aggregate CPU% across
the agent's `openclaw|claude` pids over a 1 s sample > 5 %. Both
`task-stalled-no-agent` and `agent-idle-with-queue` skip firing when
`is_busy=true`. `task-stalled-no-progress` (active session but no Jira
update — heartbeat-loop pattern) is unaffected by design. Dashboard
runs the cheap version (signals 1+2) and surfaces a `⚙ busy` chip on
agent cards. Karen's `INCIDENT_HANDLING.md` Step 2 also re-checks busy
before acting.

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
