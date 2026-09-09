# `lib/pm-consumer`

For the `pm-task/2` notification path (enabled on thinkpad since 2026-09-08), see the
[compact task runtime](../../docs/pm-task-runtime.md). Its native tool envelope
is forwarded unchanged to the gateway; the consumer and PM server must use the
same `PM_TASK_RUNTIME_V2=1` setting and PM channel plugin 0.1.2. Both services
read `/etc/default/pm-active-worktree`; persist the flag in `/etc/default/pm`
as well so the next worktree deployment retains it.

PM consumer / dispatcher (HOMELAB-46 Slice 4).

Long-running OpenClaw-side service that reads PmEvents from the
dispatch boundary (`lib/pm-dispatch`), validates them, resolves the
target agent, and wakes that agent's local OpenClaw gateway via
`POST /hooks/wake`. On same-host installs without the hook, or during a
hook outage, it can fall back to the monitor agent's `openclaw-control wake-agent`
bridge. Slices 1-3 produced the envelope and emitter side; this slice
closes the loop on the consumer end.

Direct PM chat, task chat, task-comment, and Epic chat turns are emitted
as `openclaw.pm_channel_turn` bus envelopes. The same consumer service
reads those envelopes and delivers them to the native OpenClaw `pm`
channel plugin at `/pm-channel/ingest`, which owns session recording and
final reply delivery. The older PM event envelopes remain on the same
transport for non-chat PM events such as task assignment and ack
notifications.

## Transports

Per the HOMELAB-45 In Review memo (commentId 12162), the consumer
exposes three transports:

| Transport     | Selection                                                | Role                                                     |
|---------------|----------------------------------------------------------|----------------------------------------------------------|
| AF_UNIX       | `PM_CONSUMER_SOCKET=<path>`                              | Primary. NDJSON over a per-host socket.                  |
| File-drop     | `PM_CONSUMER_DROP_DIR=/var/lib/pm/drop`                  | Fallback. One JSON file per envelope; consumed in order. |
| HTTP localhost| `PM_CONSUMER_HTTP_PORT=<port>` + `PM_CONSUMER_HTTP_TOKEN`| Explicit-opt-in only. Loopback bind, Bearer auth.        |

Native PM-channel producers additionally set `PM_CHANNEL_BUS_DROP_DIR`
to the same path as `PM_CONSUMER_DROP_DIR` unless a socket or HTTP bus is
deployed. Without one of `PM_CHANNEL_BUS_SOCKET`,
`PM_CHANNEL_BUS_DROP_DIR`, or `PM_CHANNEL_BUS_HTTP_URL`, native chat jobs
cannot leave the PM worker.
`PM_OPENCLAW_CHANNEL_HTTP_FALLBACK=1` keeps the old direct localhost
gateway POST available as a degraded fallback, but the normal production
path should remain bus-first so worktree switching and consumer
ownership stay explicit.

Both socket and file-drop legs can run concurrently and an in-process
"call the consumer directly" transport is **not** exposed — that's
the boundary that keeps HOMELAB-44 rule enforcement upstream of
dispatch.

## Pipeline

For each received envelope:

1. Envelope classification. `openclaw.pm_channel_turn` is validated as a
   native PM-channel bus envelope and posted directly to the target
   agent's `/pm-channel/ingest`. Other envelopes pass through
   `parsePmEvent(raw)` for legacy PM-event validation (kind, schema, id,
   actor, task, payload). Reject path writes nothing.
2. `dedupeKeyFor(event)` — deterministic key from
   `${kind}:${task.id}:${event.id}`. Identical envelopes produce
   identical keys.
3. `appendDelivery(...)` — `PmEventDelivery.create` with
   `@unique dedupeKey`. A UNIQUE conflict shortcuts the pipeline as a
   `skipped-duplicate` outcome with no downstream side effects.
4. Target resolution — User → Agent (PM DB) → gateway port
   (`/etc/openclaw/agents.json`, override via `AGENT_INDEX_PATH`). No
   agent target ⇒ "unmatched".
5. Wake — `POST http://127.0.0.1:<gateway_port>/hooks/wake` with the
   per-agent Bearer token. This is the primary path on the local host:
   each agent gateway must be bound to loopback and expose external
   hooks with `hooks.enabled=true`, `hooks.path="/hooks"`, and
   `hooks.token`.
   If the token is missing, the endpoint is unavailable, or the request
   fails, the consumer tries the monitor same-host helper unless
   `PM_CONSUMER_MONITOR_WAKE_FALLBACK=off`.
   Exhausting both paths ⇒ "failed".
6. Audit — exactly one `ActivityLog{ kind: "agent.wake.<outcome>" }`
   row per **PmEvent** envelope, with `targetAgent` set so HOMELAB-51's
   agent-action audit trail can be queried per-slug. (Native
   `pm_channel_turn` envelopes are audited through the PM-channel run
   machinery instead, not through this row.)
   Deployment-approved Epic envelopes are project-scoped for audit
   purposes because their `task.id` field carries the Epic ID for the
   legacy envelope shape.

`PmEventDelivery` can be truncated for retention without losing the
audit trail — that's the HOMELAB-51 "audit-survives-pm_events-
truncation" property.
Duplicate file-drop envelopes are checked before insert as well as by
the unique index. Stale duplicate files should be archived after one
`skipped-duplicate` outcome instead of being retried forever.
Native PM-channel turn rows share `PmEventDelivery` for dedupe but are
not task-scoped PM events: their `kind` is `openclaw.pm_channel_turn`
and the legacy `taskId`/`taskKey`/`projectKey` columns are empty-string
placeholders. Delivery-log reporting that means "real PM task event"
must filter on non-empty task/project fields and exclude the native-turn
kind; use `isTaskScopedDelivery` for in-process queries. Native chat
latency is tracked outside `PmEventDelivery`: `PmChannelRun` stores
queued/accepted/streaming/complete timestamps, and slow
accepted-to-first-stream spans create `pm.channel.latency_warning`
activity rows. Direct-chat browser reconciliation happens through
`GET /api/agents/<slug>/chat/messages`; the consumer only owns envelope
delivery to OpenClaw.

Queue recovery deliberately uses two leases. `claimed` is only the short
dispatch lease (`PM_CHANNEL_JOB_CLAIM_TIMEOUT_MS`, default 2 minutes).
`accepted` means OpenClaw is executing or has queued the turn and uses
`PM_CHANNEL_JOB_ACCEPTED_TIMEOUT_MS` (default 30 minutes). Never reuse the
dispatch lease as an agent execution timeout: tool-heavy PM turns may produce
no PM-visible stream event for several minutes, and replaying/restarting them
mid-run destroys real work.

Context recovery is separate from execution leases. When a PM-generated turn
ends with a recognized unrecoverable context/compaction failure, the webapp
atomically rotates the scope's `AgentSessionBinding` key and the durable retry
payload before re-entering the bounded job ladder. Task sessions also rotate
preventively after `PM_TASK_SESSION_MAX_COMPLETED_TURNS` completed turns
(default 8) when no open execution episode owns rotation. With the compact
runtime enabled, checklist bookkeeping is charged to the observable tool
budget without also spending the workflow-action budget. This policy does not depend on provider-specific token accounting;
every retry receives a self-contained PM context packet and reconstructs work
from canonical task/repository state.

Compact coding-task notifications use the versioned snapshot and native
`pm_context` reads described in the runtime guide. The remaining legacy packet
is a working set, not the archive. Its aggregate inline context is
capped by `PM_CHANNEL_PRIMARY_CONTEXT_MAX_CHARS` (default 48000), and duplicated
recent-message bodies are capped by `PM_CHANNEL_RECENT_BODY_MAX_CHARS` (default
2000 each). Scoped loopback grants retain access to deeper PM history. Operators
can lower these provider-neutral ceilings for smaller local-model windows.

## HOMELAB-46 acceptance

- Typed envelope validation: `parsePmEvent` rejects anything not on
  schema version 1.
- `UNIQUE(dedupe_key)`: enforced by the `PmEventDelivery.dedupeKey`
  unique index in the Slice 4 migration.
- Replay test: `scripts/pm-consumer-replay-test.ts` fires the same
  envelope twice (once over socket, once via file-drop) and asserts
  exactly one mock-gateway hit + one delivered row + one duplicate
  audit row.

## Per-agent Bearer tokens

`POST /hooks/wake` is bearer-auth'd per the OpenClaw gateway docs
(`docs/automation/cron-jobs.md`). Tokens are resolved in this order:

1. `PM_CONSUMER_HOOK_TOKEN_<UPPERCASE_SLUG>` env var (local-dev /
   tests).
2. `PM_CONSUMER_HOOK_TOKEN_FILE` JSON map (default
   `/etc/openclaw/pm-consumer-tokens.json`).

A missing token surfaces as a `failed` outcome — the consumer never
falls back to an empty bearer. On the single-host deployment,
`openclaw/install.sh` should reconcile this file from each agent's
`hooks.token` and keep it readable only by the PM consumer service
group:

```json
{
  "coding-agent": "<same secret as coding-agent hooks.token>",
  "review-agent": "<same secret as review-agent hooks.token>",
  "monitor-agent": "<same secret as monitor-agent hooks.token>"
}
```

Gateways that receive PM-owned wake events may allow caller-provided PM
session keys:

```json
{
  "hooks": {
    "allowRequestSessionKey": true,
    "allowedSessionKeyPrefixes": ["hook:", "pm:"]
  }
}
```

Do not allow unrestricted request session keys. OpenClaw requires the
`hook:` prefix when no hook default session key is configured; PM-owned
session keys use `pm:<scope>:<scope-id>:agent:<slug>` and are persisted
in `AgentSessionBinding`.

After changing hook config, restart the affected `openclaw-gateway.service`.
Healthy local checks are: `GET /health` returns 200, `GET /hooks`
returns 405, unauthenticated `POST /hooks/wake` returns 401, and
authenticated `POST /hooks/wake` returns 200. The gateway listener
should show `127.0.0.1:<gateway_port>` in `ss -ltnp`, not
`0.0.0.0:<gateway_port>`.

## Monitor Wake Fallback

Set `PM_CONSUMER_MONITOR_WAKE_FALLBACK=off` to disable the fallback. The
legacy `PM_CONSUMER_KAREN_WAKE_FALLBACK=off` name is still honored on
older hosts. The helper path defaults to the existing host helper path
and can be overridden with `PM_MONITOR_WAKE_HELPER` or the legacy helper
environment name.

The helper should be narrowly scoped: the PM consumer user runs it with
passwordless sudo, and the helper delegates to the monitor agent's existing
`openclaw-control wake-agent` permission. This is a degraded same-host
fallback; normal task-chat and mention delivery should hit each target
agent's `/hooks/wake` endpoint directly. When the fallback is used for a
PM chat wake, the consumer passes `--session-key <pm:...>` through
the monitor helper so `openclaw system event` still lands in the PM-bound
session.

## Running

```bash
# Primary + fallback (production deployment shape):
PM_CONSUMER_SOCKET=/run/pm/events.sock \
PM_CONSUMER_DROP_DIR=/var/lib/pm/drop \
PM_CHANNEL_BUS_DROP_DIR=/var/lib/pm/drop \
pnpm tsx scripts/pm-consumer.ts

# Replay-test acceptance:
pnpm tsx scripts/pm-consumer-replay-test.ts
```

Related PM web runtime knobs:

```bash
# Keep HTTP as fallback only; omit in the normal bus-first path.
PM_OPENCLAW_CHANNEL_HTTP_FALLBACK=1

# Slow first-token warning threshold.
PM_OPENCLAW_FIRST_STREAM_WARNING_MS=15000

# Direct-chat context controls.
PM_DIRECT_CHAT_CONTEXT_MESSAGES=14
PM_DIRECT_CHAT_ARCHIVE_CONTEXT_MESSAGES=12
PM_DIRECT_CHAT_ARCHIVE_CHAIN_LIMIT=2
PM_DIRECT_CHAT_ALWAYS_INCLUDE_FILES_CONTEXT=0
```

## Rebuild / Restart Guidance

- Schema change: `pnpm prisma migrate deploy` (or `db push` for the
  dev DB) applies the Slice 4 migration that adds `PmEventDelivery`.
  Existing tables are untouched.
- App rebuild: not required — the consumer is a separate `tsx`
  process, not bundled into Next. The PM webapp (`pnpm dev` /
  `pnpm build`) is unaffected by Slice 4 and does not need a restart
  to keep emitting events.
- Live consumer: restart the `pm-consumer` process or
  `pm-consumer.service` to pick up new code. Stopping it mid-flight is safe —
  unprocessed file-drop envelopes survive on disk and the socket leg
  re-binds on next start.
