# Monitoring

The monitoring agent runs under a host-local monitor user. Identity,
capabilities, and Telegram bot handle live in `/etc/openclaw/agents.json`.

For full architecture (triage flow, decision contract, fallback rules,
self-incident guard), see [`../../README.md`](../../README.md) § *Monitoring and Recovery*. This file is
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
    `moonlight:/srv/backups/openclaw/thinkpad`.
- **Per-agent services** derived at runtime from `agent-defaults.json` based on
  the agent's `role` plus enabled `integrations` (e.g. `openclaw-gateway`,
  `openclaw-gmail-listener`, `openclaw-webhook-receiver`,
  `openclaw-mail-listener`). Per-agent `services` in `agents.json` adds extras.
- **Per-agent gateway memory** from systemd's `MemoryCurrent` cgroup
  accounting. Unless `/etc/ai-monitor/config.json` explicitly overrides
  `warn_mib` / `critical_mib`, `gateway_memory_check` follows each unit's
  `MemoryHigh` and `MemoryMax` settings. Under thinkpad's current policy that
  means a warning at 8 GiB and a critical issue at 10 GiB; 8/10 GiB are also
  the fallback values if systemd does not expose the unit limits.
  `memory.current` and main-process RSS are bounded fallbacks when systemd
  cannot return the property. An active gateway with no usable accounting
  raises `gateway-memory-unavailable` instead of silently leaving a blind
  spot.
- **Gateway stalled-session watchdog** (in-gateway, not an ai-monitor
  probe): `diagnostics.stuckSessionAbortMs` is set to `7200000` (2 h)
  fleet-wide in each per-agent
  `/srv/agents/openclaw/<agent>/openclaw.json`. The default ~6 min
  active-abort was killing healthy long claude-cli embedded runs — that
  backend emits no internal progress events, so a long turn looks stalled
  to the gateway watchdog. The knob is hot-reloaded (the heartbeat
  re-resolves it every 30 s tick; no gateway restart needed). True hangs
  are still covered by the claude-cli subprocess's own no-output and
  whole-turn timers, which reset on every stdout chunk.
- **Unsafe previous shutdown evidence** from the current boot journal's
  explicit recovery/unclean-close messages and kernel/firmware pstore crash
  records. `previous-shutdown-unclean` is emitted only for affirmative local
  evidence. A missing clean-shutdown marker alone never alerts because journal
  retention can make that inference unreliable.
- **Listeners** declared under `listeners` in `agents.json`.
- **Bitbucket token expiry (early warning)**: Atlassian API tokens expire and
  cannot be renewed automatically, so renewal is always an operator action.
  When the operator records the expiry date in `<bitbucketTokenFile>.expiry`
  (ISO `YYYY-MM-DD`, shown once at token creation), `openclaw-integrity-check`
  fails past the date and warns within 14 days — surfacing renewal *before*
  the API starts returning 401s instead of after.
- **Active model authentication and Claude renewal**: every integrity tick
  reads `openclaw models status --json`, so it checks the current SQLite-backed
  profile store instead of the retired `auth.json`. Only providers reachable
  from the active default/fallback chain can alert; an old unused profile does
  not make an agent unhealthy. For `claude-cli`, the native Claude login owns
  renewal: normal Claude use rotates its short-lived access token through the
  refresh token in `~/.claude/.credentials.json`. The integrity check verifies
  that native login and refresh token, warns seven days before the refresh
  credential expires, and fails immediately if the CLI is logged out or the
  credential can no longer renew. Recovery is `claude auth login`, followed by
  `openclaw models auth login --provider anthropic --method cli --force`.
- **Agent doc drift**. `probe_agent_symlinks` checks every enabled agent's
  `~/.openclaw/openclaw.json` resolves to
  `/srv/agents/openclaw/<agent>/openclaw.json` (the home config stays a
  symlink to the canonical runtime config) and that the agent-facing docs
  in `~/workspace` / `~/.openclaw/workspace` match the active PM worktree's
  `ai/openclaw` docs by content hash (the propagation model copies docs in,
  not symlinks them). `USER.md` resolves to the shared agent file
  under `/srv/agents/openclaw/_shared` when present. Config drift is `crit`
  because a stale regular home config can break gateway auth; doc drift is
  `warn`. Alert kinds: `agent-config-symlink-drift` (the openclaw.json
  symlink) and `agent-doc-drift` (a workspace doc that is missing or whose
  content no longer matches the canonical source).
- **Stalled Jira tickets** for any agent with `role: "coding"` and
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
- **Pending comments on assigned Jira issues** in
  `/var/lib/ai-monitor/pending-assignee-comments/`. When a new Jira comment
  lands on an issue assigned to a coding agent, the receiver records a marker
  unless the assignee wrote the comment. `probe_pending_assignee_comments`
  resolves on an assignee reply or Done status; otherwise it fires
  `assignee-comment-awaiting-reply` and wakes the assignee to read the comment
  and reply if required.
- **Pending Epic-owner comment review** in
  `/var/lib/ai-monitor/pending-epic-comments/`. When a known agent posts a new
  Jira comment on an issue under an Epic, the webhook receiver records a
  marker. `probe_pending_epic_comment_reviews` resolves the parent Epic owner,
  clears the marker if the Epic is done/unowned or the owner has replied, and
  otherwise fires `epic-comment-awaiting-reply` at warn 15 min / crit 60 min.
  This kind bypasses monitor triage and wakes the Epic owner directly.
- **Idle agent with non-empty queue** for any coding agent. `probe_agent_queue`
  fires `agent-idle-with-queue` when an agent has zero tickets In Progress
  but ≥1 in any of the configured `queue_statuses` (default
  `["Selected for Development", "To Do"]`) AND their session has been
  idle past threshold (default warn 10 min / crit 30 min, configurable
  under `agent_queue_check`). Closes the gap `task-stalled-no-agent`
  cannot see (after a ticket transitions out of In Progress, that probe
  loses the attachment point). Handled deterministically by ai-monitor —
  bypasses monitor-agent judgment entirely (see
  `monitor_triage.auto_action_kinds_bypass_monitor`) and runs
  `openclaw-control wake-agent <user>` directly with a reminder naming the
  queued ticket keys and referencing WORKFLOW.md *"Picking your next
  task"*. Rationale: situation is unambiguous and the action is bounded; no
  triage judgment needed.
- **Pending email tasks** for any coding agent with email integration.
  Gmail and local Maildir listeners are the first responders: when an
  allowlisted sender or local email-capable agent sends an actionable request,
  the listener queues the task and immediately wakes the owner through
  `/usr/local/sbin/openclaw-control wake-agent <self>`. `probe_pending_email_tasks`
  is the fallback if that immediate wake does not result in action. It scans
  `~/tasks/current.md` for sections with `Gmail messageId:` and
  `Status: QUEUED`. It fires `email-awaiting-action` at warn 15 min / crit
  60 min, ignores entries older than 24 h, and bypasses monitor-agent judgment
  so ai-monitor can run `wake-agent` directly. The wake reminder tells the
  agent to process the queued email, reply in the original thread when required, include the
  configured signature/runtime model, and update the task status out of
  `QUEUED`.
  Recovery for this kind is task-status based: the wake/restart is not
  considered successful while the same Gmail messageId is still `QUEUED`.
  `openclaw-control` also clears stale non-running `pendingFinalDelivery*`
  state before each wake so CLI system events cannot wedge the next turn.
- **Mission Control / PM workflow drift**. `probe_pm_workflow` opens the PM
  SQLite database read-only and checks Mission Control rules without
  mutating rows. Backlog tasks are a hard suppression boundary: the monitor
  emits no workflow, channel, orphan-bubble, human, or resolved alert for
  them. It alerts/wakes for `To Do` tasks missing an Action Plan or awaiting
  approval, `To Do` tasks not moved to `In Progress`, stale `In Progress`
  tasks, `Review` tasks waiting on the resolved reviewer, review feedback
  waiting on the assignee, and tasks blocked by a non-actionable Epic
  (status `Backlog` or `Done` — `pm-epic-not-open`). Closed-Epic drift is
  collapsed to one incident per Epic and targeted at the human reporter or
  owner; historical retired Epic statuses are ignored instead of fanning out
  child-task alerts. It also reports stale active workflow live-bubble turns whose
  original PM notification no longer matches the task's current
  owner/status. Defaults are intentionally short because Mission Control is
  the source of truth and the first wake already happened: `To Do` not started after 2 min, `In Progress` stale
  after 5 min, and Review waiting after 10 min. `In Progress` remains the
  state for incomplete implementation, including a formal infrastructure,
  credential, external-service, or human-decision blocker; `Review` is only
  for completed work awaiting review. A formal blocker suppresses ordinary
  stale-assignee recovery until the assignee records that it is cleared. A
  generic `alertReporter` value alone does not suppress recovery because
  repository and administrative alerts use that flag too. Task execution
  stays with the visible assignee; independent cross-agent work requires a
  separate explicitly assigned PM task. For `In Progress` tasks, the
  stale timer is reset by the assignee's latest task comment after the
  task entered `In Progress`, so real progress suppresses repeat nudges while
  silence still escalates. PM workflow kinds bypass monitor-agent judgment and
  use the deterministic ladder directly: T1 sends a native PM-channel workflow
  nudge with the full PM task context packet, T2 repeats the nudge, and T3
  performs a final recovery attempt. Semantic workflow drift never restarts a
  healthy gateway/browser; restart is reserved for concrete
  `pm-channel-no-start`, `pm-channel-stalled`, or `pm-channel-failed` evidence.
  `In Progress` recovery uses the current task execution episode. PM rotates
  the episode after the configured completed-turn budget or unrecoverable
  context/compaction failure and reconstructs from canonical PM/repository
  state. Telegram is sent only on the next tick if the same issue
  is still present after T3's confirmation window. Wake reminders include
  task id, project, status, Epic status, and the required next PM action.
  Agent-targeted PM workflow drift is retryable after Telegram via
  `pm_workflow.retry_after_tier3_seconds` instead of being permanently
  suppressed while the task remains stale. A PM-channel nudge
  run counts as confirmed only when the run is alive — status `streaming`
  or `complete`, or freshly `accepted`; a `failed` run never counts as
  recovery. The stalled-turn scan also covers runs that ended badly: a
  terminally `failed` PM-channel run with no durable reply raises
  **`pm-channel-failed`** (warn). Its unit is failure-instance-scoped
  (`pm:<agent>/<task>/failed:<failedAt>`), so each failure epoch gets one
  bounded nudge/restart recovery cycle instead of re-alerting forever on
  the same terminal row; failures older than
  `pm_workflow.failed_run_max_age_hours` (default 48) never alert, and
  `retryable` runs (mid retry-backoff) are suppressed until twice the
  channel-stall warn threshold. Before issuing a non-channel recovery, the
  monitor also suppresses duplicate work while any queued, accepted,
  streaming, or retryable PM-channel run exists for the same task and agent.
  When a resolved nudge target is a human
  rather than an active agent, the recovery ladder and service restarts are
  skipped — the human gets a single Telegram/board notification, deduplicated
  until the underlying PM state changes.
  An `accepted` turn gets a separate execution grace
  (`pm_workflow.channel_accepted_warn_minutes`, default 30) before stalled-turn
  recovery. The ordinary two-minute no-start threshold applies to dispatch,
  not a live tool-heavy agent execution; restarting inside that grace can kill
  the very browser/tool work the workflow is waiting for.

## Registry-driven

The registry (`agents.json`) and the defaults schema (`agent-defaults.json` in
this repo, symlinked to `/etc/openclaw/agent-defaults.json`) together drive
what's monitored. `agents.json` carries flags only; services and capabilities
are derived:

- `enabled: true` — included in monitoring sweeps and probes.
- `role: "coding" | "monitor"` — exclusive identity; drives the
  `byRole` block in `agent-defaults.json` (caps + services). A coding agent
  modifies code and works tickets; a monitor agent triages incidents, wakes
  and restarts other agents, sends alerts. Never both.
- `integrations` — each truthy integration adds services and capabilities
  via `agent-defaults.json` `byIntegration[k]` (e.g. `gmail: true` adds
  `openclaw-gmail-listener.service` and `can_send_email: true`).
- `listeners` — expected TCP listeners (host-specific; not derivable).

`openclaw-registry-check --runtime` also verifies the host-managed Chromium
executable and every enabled agent's browser policy (`enabled`, executable,
headless mode, sandbox retained, and private `openclaw` default profile).
Periodic monitoring deliberately does not launch or browse a page every two
minutes; use `sudo -u <agent> env HOME=/home/<agent> openclaw browser doctor
--deep` for an end-to-end CDP/page/snapshot probe during provisioning or
incident recovery.
- `services` (optional, per-agent) — extra services appended to the derived
  list. Use for project-specific extras the defaults don't know about.
- `capabilities` (optional, per-agent) — key-by-key overrides of the
  derived capabilities (e.g. read-only mode for maintenance: `{ can_modify_code: false }`).

Consumers (`ai-monitor`, `openclaw-integrity-check`, `agent-dashboard`)
call a shared `derive_effective_agent(agent, defaults)` helper that does
the merge. After that step every agent record exposes its `services` and
`capabilities` arrays — same shape as the legacy explicit form, derived
not authored. See the comments block at the top of `agent-defaults.json`
for the merge algorithm.

### Monitor chat diagnostics

When the monitor agent is asked in PM direct chat about a named agent,
gateway, or service, the local OpenClaw session list is not authoritative.
The monitor must inspect the host fleet registry and runtime state:

1. Resolve the agent in `/etc/openclaw/agents.json` or
   `/srv/agents/index.json`.
2. Get the Linux UID with `id <agent>` and use
   `XDG_RUNTIME_DIR=/run/user/<uid>` for user-service commands.
3. Check the target service as the target user, for example
   `systemctl --user status openclaw-gateway.service --no-pager`.
4. Read recent target-user journal lines for `openclaw-gateway.service`.
5. Use `openclaw-control wake-agent`, `restart-services`, or
   `restart-and-wake` only after the live checks identify a recoverable
   condition.

### Per-agent project resources (`~/.local/openclaw/monitor.json`)

Each agent declares their own project resources (side projects, dev
playgrounds, containers) in `~/<user>/.local/openclaw/monitor.json`:

```json
{
  "version": 1,
  "resources": [
    {
      "name": "wdt",
      "description": "Whitsunday Discovery Trail dev playground",
      "enabled": true,
      "services": ["wdt-<user>.service"],
      "listeners": [
        { "host": "127.0.0.1", "port": 3001, "owner": "wdt", "expected": true }
      ]
    }
  ]
}
```

The single `enabled` flag controls **both** sides at once:

- **Service lifecycle**: `openclaw-monitor-sync` (system service, root)
  reconciles actual systemd state against the file. `enabled: true` →
  unit is `systemctl --user enable --now`. `enabled: false` → unit is
  `systemctl --user stop` (kept installed; flip back to restart).
- **Monitoring sweep**: `ai-monitor`, `openclaw-integrity-check`, and
  `agent-dashboard` merge each enabled resource's `services` and
  `listeners` into the effective agent view. Disabled resources are
  invisible to monitoring — no false alerts about stopped units.

Triggers for `openclaw-monitor-sync`:

- `openclaw-monitor-sync.path` — watches every per-agent `monitor.json`;
  fires the reconcile within ~1 s of a write.
- `openclaw-monitor-sync.timer` — periodic drift correction every 5 min.
- Manual: `sudo /usr/local/sbin/openclaw-monitor-sync [<user>]`.

To add a project: write the file, set `enabled: true`, done — no central
registry edit. To temporarily pause monitoring + running: flip `enabled`
to `false` and write the file. Idempotent.

Webhook routing is derived from `/srv/agents/index.json` via
`/etc/openclaw/agents.json`. Enabled coding agents with
`integrations.jira: true` receive Jira events; enabled coding agents with
`integrations.bitbucket: true` receive Bitbucket events.

Validate drift after any registry/service edit:

```
/usr/local/bin/openclaw-registry-check          # static checks
/usr/local/bin/openclaw-registry-check --runtime # also services + ports
/usr/local/bin/openclaw-boot-readiness           # full post-reboot check
```

## Notifications

`/etc/ai-monitor/config.json` routes alerts through the monitoring agent.
Telegram bot, secrets, and chat allowlist are per-agent — see the registry
(`telegram.bot` for the monitor user), `~/.config/openclaw/openclaw-secrets.env`,
and `~/.openclaw/credentials/telegram-allowFrom.json`.

### Tier framework — three recovery attempts, telegram after the third fails

Every alert key gets up to **three recovery attempts**; Telegram is sent
only after the third attempt fails.
Configured under `monitor_triage.escalation_ladder` in
`/etc/ai-monitor/config.json` (`max_attempts: 3`,
`confirmation_window_s: 300`). Two execution paths:

- **Bypass-monitor kinds** (default `agent-idle-with-queue`,
  `email-awaiting-action`, and all `pm-*` workflow-action kinds):
  T1 = `wake-agent` for generic queues/email or native PM-channel nudge for
  PM workflow drift. For semantic PM drift, T2 repeats the native nudge and T3
  is the final nudge; only explicit PM-channel delivery/runtime failures may
  restart services. Generic queue/email kinds retain their existing heavier
  recovery. T4 = Telegram with attempt history only if the issue remains after
  T3. ai-monitor runs the actions itself; the
  monitor agent is not in this judgment loop.
- **Monitor-agent-bound kinds** (everything else): incident payload includes
  an `escalation_context` block (`{attempt, max_attempts, is_final,
  prior_attempts, guidance}`). On non-final attempts the monitor agent is told
  to act and `suppress` with `telegram_sent: false`. On final failure,
  ai-monitor includes the recovery history before paging.

Between tiers, ai-monitor sets `next_attempt_after = now + 300 s` on the
event. New alerts for the same key are silently skipped during the
confirmation window. Recovery (issue stops appearing in next probe sweep)
clears the event silently via `missed_runs` eviction. Per-event state
(`attempts`, `attempt_history`, `next_attempt_after`) is in
`/var/lib/ai-monitor/state.json`.

The monitor agent playbook (which kind -> which fix on which tier) lives at
`INCIDENT_HANDLING.md`. The monitor agent also has `systemctl restart` permission
for `ollama`, `nginx`, `mariadb`, `php-fpm`, `agent-dashboard`, and
`openclaw-typing-keepalive` through the host sudoers policy.

### Monitor agent heartbeat hygiene

`openclaw system event --mode now` (the wake mechanism ai-monitor uses to
hand the monitor agent an incident) marks the monitor agent's `agent:main:main` entry's
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
"<reason>"` (the user is whatever the registry says).

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
`monitor_triage`:

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
by host systemd timers, not handed to the monitor agent:

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
agent cards. The monitor agent's `INCIDENT_HANDLING.md` Step 2 also re-checks busy
before acting.

### Broken User Managers

If `systemctl --user` probes fail with `Transport endpoint is not connected`,
`Bad message`, or `Failed to connect to bus`, ai-monitor raises
`user-manager-bus-broken` instead of one alert per affected user service. This
kind bypasses monitor-agent triage: ai-monitor restarts `user@UID.service`,
then restarts the agent's managed `openclaw-*` services through
`openclaw-control`. `openclaw-control restart-services` has the same preflight
repair, so PM workflow recovery can repair the user bus before sending a
PM-channel nudge.

## Dashboard

Read-only, real-time, basic-auth-gated:

- URL: `https://dev.vixi.au/agents.html`
- Backend: `agent-dashboard.service` on `127.0.0.1:3013` (HTTP + SSE),
  registry hydration via `/agents/registry.json`.
- Architecture detail: [`../../README.md`](../../README.md) § *Agent Dashboard*.

## Known risks

- The host is a **single point of failure** for its agents, monitoring,
  playgrounds, and remediation. Disk-loss risk is bounded only as long as
  off-host backup stays current.
- **Gmail watches expire** and must keep renewing successfully.
- **Self-incidents** (issues affecting the monitor user or `ai-monitor` itself) bypass
  the triage handoff and go to direct Telegram — the monitoring agent can't
  safely triage its own outage.
- **Per-user secret split** is correct for least privilege but makes audits
  dependent on `/usr/local/bin/openclaw-backup --inventory` plus
  `openclaw-registry-check`.
- **Documentation drift** is possible if future changes bypass the registry
  and shared docs.
