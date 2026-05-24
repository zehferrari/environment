# OpenClaw PM Channel

Native local OpenClaw channel for the Vixi PM webapp.

PM sends direct chat, task chat, and task-comment turns to each agent's local
OpenClaw gateway at `/pm-channel/ingest`. The plugin runs the OpenClaw channel
turn kernel, so OpenClaw owns session recording and model dispatch. Partial
reply chunks are POSTed back to PM at `/api/openclaw/pm-channel/stream` for the
live browser projection; durable final replies are POSTed back at
`/api/openclaw/pm-channel/reply`.

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

Install and configure all local agent accounts from the PM web root with:

```bash
sudo node deploy/install-openclaw-pm-channel.mjs --restart
```

The installer stages a root-owned copy at
`/usr/local/share/openclaw/plugins/pm-channel` before linking it into each
agent's OpenClaw config. Do not link the worktree path directly for
multi-user gateways; OpenClaw will block plugin paths owned by another
non-root user.
