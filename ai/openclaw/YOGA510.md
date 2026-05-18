# yoga510 OpenClaw Agents

Installed on 2026-05-17 for host `mail.eurekafiles.com` / `yoga510`.

## Local Users

Yoga510 is a new agent instance. It shares selected operating behaviour with x1, but its agents are not continuations, replacements, or clones of previous agents.

| yoga510 user | Role |
|---|---|
| rachael | owner/admin |
| ada | code agent |
| claudia | code agent |
| emery | monitor agent |

## Runtime Layout

- Environment repo: `/home/rachael/Code/environment` (kept outside the samba-backed `/srv` tree).
- Shared OpenClaw docs and skills: `/home/rachael/Code/environment/ai/openclaw`.
- Agent users access the repo through group/ACL permissions on `/home/rachael/Code`; each agent has `~/Code -> /home/rachael/Code`.
- Agent registry: `/etc/openclaw/agents.json` -> `/srv/agents/index.json`. The live file uses the same registry schema as x1 (`version`, `description`, `sharedKnowledgeDir`, `webhookRoutedUsers`, `agents`), with yoga510 users and paths.
- Dashboard config: `/etc/agent-dashboard/config.json`.
- Dashboard source files and nginx web root: `/home/rachael/Code/environment/ai/web`.
- Nginx serves `agents.html` directly from the repo checkout; stale `/srv/www/agents*.html` deployment copies are not used on yoga510.
- Agent avatars are served by nginx from `/srv/agents/Pictures/<Name>/avatar.png` through `/agents/avatars/<Name>`.
- Agent workspaces: `/home/{ada,claudia,emery}/workspace`.
- Agent state: `/home/{ada,claudia,emery}/.openclaw`.

## Mail

Yoga510 does not use Gmail/Google watchers. Agent email is local-first:

- Incoming mail: `~/Maildir` via Postfix local delivery.
- Reading/listing/replying: `~/workspace/mail`, symlinked to `skills/local-mail`.
- Outgoing mail: local Postfix through `/usr/sbin/sendmail -oi -t`.
- Listener service: `openclaw-mail-listener.service` writes events to `~/.openclaw/mail/events.jsonl`.
- Action/reply allowlist: `skills/local-mail/auto-reply-policy.json`.
  `mail-list-inbox.js` and `mail-get-text.js` report allowlist status for senders,
  while `mail-send.js` and `mail-reply.js` refuse recipients outside the policy.

Dovecot IMAP remains available for normal mail clients, but OpenClaw does not require IMAP credentials.

Current local-mail allowlist:

- `e@zeh.me`
- `contact@rachaelsmith.net.au`
- `rachael@eurekafiles.com`
- `smithr6804@gmail.com`
- `ada@eurekafiles.com`
- `claudia@eurekafiles.com`
- `emery@eurekafiles.com`

All local agents with mail access must remain whitelisted so they can act on and
reply to tasks sent by another local agent. If the registry gains a new
mail-capable local agent, add that agent's email to
`skills/local-mail/auto-reply-policy.json`.

## Models and Providers

- Ada uses `openai-codex/gpt-5.5` with the x1 primary code-agent fallback order.
- Claudia uses Claude CLI OAuth through the normalized `anthropic/claude-opus-4-7` provider, with the x1 secondary code-agent fallback order.
- Emery uses the x1 monitoring-agent Ollama cloud fallback stack.
- All Ollama cloud entries use `https://ollama.zeh.me`.

## Telegram

Ada, Claudia, and Emery follow the x1 config shape: a single top-level `channels.telegram` block, not per-account `channels.telegram.accounts.*` entries. Tokens live only in per-user files:

- `/home/ada/.config/openclaw/telegram-token`
- `/home/claudia/.config/openclaw/telegram-token`
- `/home/emery/.config/openclaw/telegram-token`

Token files are mode `0600` and owned by the agent user. The config shape is:

```json
{
  "enabled": true,
  "dmPolicy": "pairing",
  "groupPolicy": "allowlist",
  "streaming": { "mode": "partial" },
  "tokenFile": "/home/<agent>/.config/openclaw/telegram-token"
}
```

Validate with `openclaw channels list` as each user, then restart `openclaw-gateway.service`, `openclaw-mail-listener.service`, and `openclaw-webhook-receiver.service`.

## Services

Per agent user services:

- `openclaw-gateway.service`
- `openclaw-mail-listener.service`
- `openclaw-webhook-receiver.service`

Host services:

- `agent-dashboard.service` on `127.0.0.1:3013`
- `openclaw-typing-keepalive.service`
- `openclaw-backup.timer`
- `openclaw-integrity.timer`

Gateway ports:

- Ada: `18789` on LAN
- Claudia: `18790` on LAN
- Emery: `18793` loopback only

## Validation

Run:

```bash
/usr/local/bin/openclaw-integrity-check
```

Expected result after install: `warn=0 fail=0`.
