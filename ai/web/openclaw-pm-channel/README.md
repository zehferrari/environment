# OpenClaw PM Channel

Native local OpenClaw channel for the Mission Control webapp.

Version 0.1.4 adds backend-aware native capabilities. Claude CLI subprocesses
cannot use gateway-registered tools; PM sends them the compact scoped HTTP
contract instead. The backend check includes configured fallbacks and fails
conservatively when the model is unknown. The bundle now also includes
`task-backend.js`. Deploy the matching PM web/consumer code before installing
this plugin: old web code cannot generate the compact HTTP alternative.

The model turn finishing is distinct from the requested workflow outcome.
Explicit planning turns that finish without a submitted plan now raise a
reporter alert and record the missing outcome; they do not automatically retry.

Version 0.1.3 repairs native-tool discovery: all 15 tools are declared in
`openclaw.plugin.json` → `contracts.tools`. Current OpenClaw selects plugins
from those declarations before invoking their tool factories; `registerTool`
alone does not expose tools. The capability handshake checks the declarations
and refuses to advertise runtime support if any are missing. Validation must
include a real task turn using `pm_context`, not just the capabilities endpoint.

Version 0.1.2 adds task-scoped native tools and numeric usage telemetry.
It is installed on all four enabled thinkpad gateways as of 2026-09-08, with
`PM_TASK_RUNTIME_V2=1` enabled in the PM website and consumer.
The bundle includes `task-tools.js` and `task-telemetry.js`; they must be staged
with `index.js`. Authenticated `GET /pm-channel/capabilities` advertises runtime
version 1. PM gates compact turns behind `PM_TASK_RUNTIME_V2=1` and checks that
capability before delivery. See [runtime and rollout](../docs/pm-task-runtime.md).
Existing turns without `taskRuntime` continue to use the legacy channel path.

PM sends direct chat, task chat, task-comment, and epic chat turns to each
agent's local OpenClaw gateway at `/pm-channel/ingest`. The plugin runs the
OpenClaw channel turn kernel, so OpenClaw owns session recording and model dispatch. Partial
reply chunks are POSTed back to PM at `/api/openclaw/pm-channel/stream` for the
live browser projection; durable final replies are POSTed back at
`/api/openclaw/pm-channel/reply`.

The stream also forwards one deduplicated `tool:call` event for each OpenClaw
tool invocation. Mission Control spends those events against the task's
bounded execution episode so browser-heavy turns roll into a fresh, checkpoint-
backed session before their context becomes unmanageable. Stream and durable
reply callbacks carry the actual provider/model selected by OpenClaw, including
fallback changes; do not infer model provenance from the agent's configured
default.

The final reply callback is the source of truth for success. A stream
`done` only closes a successful stream after a visible reply was delivered.
If the turn exits without a visible reply, the plugin posts a stream
`error` so PM can mark the `PmChannelRun` failed instead of leaving the
chat UI waiting.

PM context is attached as supplemental channel context. The plugin keeps
the visible wake body focused on the current message instead of duplicating
the full context packet into both the message and supplemental context.

Task and Epic Discussion replies use a two-section final format: Section A
is the full formatted answer, and Section B is the short user-facing
summary. The browser shows Section B by default after the final reply is
saved, while live streaming displays Section A.

Minimal `openclaw.json` channel config:

```json
{
  "channels": {
    "pm": {
      "enabled": true,
      "token": "env:PM_OPENCLAW_CHANNEL_TOKEN",
      "callbackToken": "env:PM_OPENCLAW_CHANNEL_TOKEN",
      "callbackUrl": "http://127.0.0.1:3000/api/openclaw/pm-channel/reply",
      "agentId": "main"
    }
  }
}
```

Install and configure all enabled local agent accounts from the PM web root with
the PM service group (`karen` on thinkpad):

```bash
sudo node deploy/install-openclaw-pm-channel.mjs --registry /etc/openclaw/agents.json --token-group karen --restart
```

The installer stages a root-owned copy at
`/usr/local/share/openclaw/plugins/pm-channel` before linking it into each
enabled agent's OpenClaw config. Do not link the worktree path directly for
multi-user gateways; OpenClaw will block plugin paths owned by another
non-root user.

## Per-turn effort (0.1.5)

Authenticated PM ingress can carry `effortPolicy` (normal or manager). PM resolves
that policy from current database roles at dispatch, including queued jobs. The
plugin queries gateway session metadata and uses a one-shot
`replyOptions.thinkingLevelOverride`: High for ordinary work; xHigh, then Max,
then High for manager work, where supported. It never persists a `/think`
command in the session. Ollama follows the same advertised xHigh → Max → High
selection order. The current native adapter maps xHigh/Max to High on the wire;
PM passes the selected level to OpenClaw without a provider-specific cap.
Metadata lookup failure falls
back to a per-turn High default normalized by OpenClaw and emits a warning.
For a provisioned Fable 5.1 CLI backend, the plugin instead clones its
`CLAUDE_CODE_EFFORT_LEVEL` environment per turn, because the installed
OpenClaw policy advertises Thinking Off for that route. This requires a current
Claude Code CLI; High/xHigh were verified using its actual effort hook.
See [the model/effort runbook](../docs/agent-model-upgrades.md).


## Terminal turns (0.1.6)

The compact contract uses OpenClaw's `NO_REPLY` token. Legacy
`PM_SILENT_NO_CONTRIBUTION` responses remain readable during rollout. Exact
silent output is observed through the model-output hook so a core-suppressed
reply can complete normally instead of becoming a missing-reply failure.

A successful native PM mutation with `turnComplete: true` or a finish/wait
effect fences subsequent PM tools and requests a non-blocking abort of the
current harness run. Both generation checks and successful HTTP/business
status are required. Context prose and failed responses cannot stop a turn.
The resulting dispatch unwind completes successfully; it is not cancellation
or a retryable error. A superseded generation cannot stop its successor.
This native-tool boundary does not intercept Claude CLI's shell HTTP calls;
those receive the unified silence instruction and existing HTTP completion
contract. Unsupported harness stop APIs log a warning and retain the tool fence.

## Task output channels (0.1.11)

Autonomous task narration is stored by PM as Thinking history, not comments.
`pm_task_note` explicitly publishes a concise finding/decision/question through
the scoped `/notes` endpoint without ending the turn. Claude CLI uses the same
HTTP endpoint from `pm-task/3`. Workflow actions already publish blocker and
completion evidence. The existing progress/reasoning/tool stream feeds the new
Thinking tab; unavailable provider summaries are not fabricated.
See [task Thinking](../docs/task-thinking.md) for access, retention and deployment.

## Evidence and checkpoint delivery (0.1.12)

Native `pm_attach_file` explicitly supplies the configured agent workspace to
OpenClaw's media reader. Place deliverables in that workspace or its supported
OpenClaw media directory; repository paths do not become upload roots merely
because the task uses them. Size limits, real-path/symlink checks, and ingress
generation fencing remain enforced. Errors explain where to stage evidence.

Native harness turns use live checkpoint steering. CLI turns use the scoped
HTTP contract: checkpoint at meaningful boundaries and at least every six tool
calls. Context and successful workflow responses include `executionGuidance`
with the current episode's remaining calls and `checkpointDue` reminder.
The steering endpoint reports `queued:false, delivery:workflow_response` for
this mode; it does not claim live injection or launch/interrupt a CLI session.
These reminders are advisory; the existing hard episode limit remains.
