# OpenClaw PM Channel

Native local OpenClaw channel for the Mission Control webapp.

PM sends direct chat, task chat, task-comment, and epic chat turns to each
agent's local OpenClaw gateway at `/pm-channel/ingest`. The plugin runs the
OpenClaw channel turn kernel, so OpenClaw owns session recording and model dispatch. Partial
reply chunks are POSTed back to PM at `/api/openclaw/pm-channel/stream` for the
live browser projection; durable final replies are POSTed back at
`/api/openclaw/pm-channel/reply`.

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

Install and configure all enabled local agent accounts from the PM web root with:

```bash
sudo node deploy/install-openclaw-pm-channel.mjs --registry /etc/openclaw/agents.json --restart
```

The installer stages a root-owned copy at
`/usr/local/share/openclaw/plugins/pm-channel` before linking it into each
enabled agent's OpenClaw config. Do not link the worktree path directly for
multi-user gateways; OpenClaw will block plugin paths owned by another
non-root user.
