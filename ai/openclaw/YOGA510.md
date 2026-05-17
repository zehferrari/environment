# yoga510 OpenClaw Agents

Installed on 2026-05-17 for host `mail.eurekafiles.com` / `yoga510`.

## User Mapping

| x1 user | yoga510 user | Role |
|---|---|---|
| zeh | rachael | owner/admin |
| asdrubal | ada | code agent |
| barekbaal | claudia | code agent |
| karen | emery | monitor agent |

## Runtime Layout

- Environment repo: `/home/rachael/Code/environment` (kept outside the samba-backed `/srv` tree).
- Shared OpenClaw docs and skills: `/home/rachael/Code/environment/ai/openclaw`.
- Agent users access the repo through group/ACL permissions on `/home/rachael/Code`; each agent has `~/Code -> /home/rachael/Code`.
- Agent registry: `/etc/openclaw/agents.json`.
- Dashboard config: `/etc/agent-dashboard/config.json`.
- Dashboard source files: `/home/rachael/Code/environment/ai/web/agents*.html`.
- Nginx web root: `/srv/www`, with `agents.html`, `agents-asdrubal.html`, and `agents-barekbaal.html` copied from the repo.
- Agent workspaces: `/home/{ada,claudia,emery}/workspace`.
- Agent state: `/home/{ada,claudia,emery}/.openclaw`.

## Mail

Yoga510 does not use Gmail/Google watchers. Agent email is local-first:

- Incoming mail: `~/Maildir` via Postfix local delivery.
- Reading/listing/replying: `~/workspace/mail`, symlinked to `skills/local-mail`.
- Outgoing mail: local Postfix through `/usr/sbin/sendmail -oi -t`.
- Listener service: `openclaw-mail-listener.service` writes events to `~/.openclaw/mail/events.jsonl`.

Dovecot IMAP remains available for normal mail clients, but OpenClaw does not require IMAP credentials.

## Models and Providers

- Ada maps to x1 asdrubal and uses `openai-codex/gpt-5.5` with the x1 fallback order.
- Claudia maps to x1 barekbaal and uses Claude CLI OAuth through the normalized `anthropic/claude-opus-4-7` provider, with x1 fallback order.
- Emery maps to x1 karen and uses the Ollama cloud fallback stack.
- All Ollama cloud entries use `https://ollama.zeh.me`.

## Telegram

Ada and Claudia follow the x1 config shape: a single top-level `channels.telegram` block, not per-account `channels.telegram.accounts.*` entries. Tokens live only in per-user files:

- `/home/ada/.config/openclaw/telegram-token`
- `/home/claudia/.config/openclaw/telegram-token`

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
