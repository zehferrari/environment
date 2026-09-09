# OpenClaw PM Channel

Native local OpenClaw channel for the Mission Control webapp.

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
