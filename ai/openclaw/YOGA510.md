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

- Environment repo: `/srv/Code/environment`
- Shared OpenClaw docs and skills: `/srv/Code/environment/ai/openclaw`
- Agent registry: `/etc/openclaw/agents.json`
- Dashboard config: `/etc/agent-dashboard/config.json`
- Agent workspaces: `/home/{ada,claudia,emery}/workspace`
- Agent state: `/home/{ada,claudia,emery}/.openclaw`

## Mail

Yoga510 does not use Gmail/Google watchers. Agent email is local-first:

- Incoming mail: `~/Maildir` via Postfix local delivery.
- Reading/listing/replying: `~/workspace/mail`, symlinked to `skills/local-mail`.
- Outgoing mail: local Postfix through `/usr/sbin/sendmail -oi -t`.
- Listener service: `openclaw-mail-listener.service` writes events to `~/.openclaw/mail/events.jsonl`.

Dovecot IMAP remains available for normal mail clients, but OpenClaw does not require IMAP credentials.

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
