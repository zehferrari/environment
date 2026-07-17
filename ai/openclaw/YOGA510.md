# yoga510 OpenClaw Agents

Installed on 2026-05-17 for host `mail.eurekafiles.com` / `yoga510`.

## Local Users

Yoga510 is a new agent instance. It shares selected operating behaviour with thinkpad, but its agents are not continuations, replacements, or clones of previous agents.

| yoga510 user | Role |
|---|---|
| rachael | owner/admin |
| ada | code agent |
| claudia | code agent |
| emery | monitor agent |

## Runtime Layout

- Canonical environment checkout: `/srv/Code/environment`.
- Active managed deployment worktree: `/srv/Code/environment.worktrees/main`.
  Mission Control and the reconciled OpenClaw files are deployed from this
  worktree, not from the canonical checkout.
- The owner checkout `/home/rachael/Code/environment` is also present for
  owner-side compatibility. It is never the deployment or shared-document
  reconciliation source.
- Shared OpenClaw docs and skills in the active deployment:
  `/srv/Code/environment.worktrees/main/ai/openclaw`.
- Repository access is shared through the `code-agents` group and ACLs.
- Agent registry: `/etc/openclaw/agents.json` -> `/srv/agents/index.json`. The live file uses the same registry schema as thinkpad (`version`, `description`, `sharedKnowledgeDir`, `agents`), with yoga510 users and paths.
- Mission Control app source: `/srv/Code/environment.worktrees/main/ai/web`.
- Mission Control database: `file:/srv/Data/pm/wt-main.db`.
- Legacy agent-dashboard config: `/etc/agent-dashboard/config.json`.
- Agent avatars are served by nginx from `/srv/agents/Pictures/<Name>/avatar.png` through `/agents/avatars/<Name>`.
- Agent workspaces: `/home/{ada,claudia,emery}/workspace`.
- Agent state: `/home/{ada,claudia,emery}/.openclaw`.

## Mission Control and Legacy Dashboard

Yoga510 deliberately has two different web interfaces:

- **Mission Control** is the current Next.js PM application at
  `https://agents.eurekafiles.com`. Nginx proxies it to
  `127.0.0.1:3000`; the host-wide `pm.service` and
  `pm-consumer.service` both run as `emery` from the active managed
  worktree.
- **Agent dashboard** is the older read-only activity page at
  `https://dev.eurekafiles.com`. It remains available through
  `agent-dashboard.service` on `127.0.0.1:3013`; it is not the PM UI and
  must not replace the `agents.eurekafiles.com` upstream.

The application, lockfile, Prisma migration history, service templates,
worktree switcher, maintenance page, nginx template, and native PM-channel
installer are all tracked under [`../web/`](../web/). Host secrets remain in
`/etc/default/pm` and `/etc/openclaw/`; never copy them into the repository.
The complete first-install procedure is
[`../web/deploy/README.md`](../web/deploy/README.md).

For a normal yoga510 release, use the guarded root entry point. It runs Git and
the frozen dependency install as the repository owner, refreshes the installed
helpers/host contract, and runs the migrate/build/switch as the monitor user:

```bash
sudo /srv/Code/environment.worktrees/main/ai/web/deploy/update-managed-host.sh \
  --worktree /srv/Code/environment.worktrees/main \
  --repo-user rachael --monitor-user emery --branch main
```

The updater refuses dirty, local-ahead, detached, or diverged worktrees and
never resets or commits local work. Its final `pm-switch` step applies committed
Prisma migrations to `/srv/Data/pm/wt-main.db`, builds the standalone
application, points both PM services at the same worktree/database, restarts
them, and checks the login page and one hashed asset. Do not run `prisma db
push` against this database, and do not run `next build` without the
switch/restart step.

Every local OpenClaw gateway used by Mission Control must bind to loopback.
Nginx may expose an authenticated gateway control UI, but it must not proxy
`/hooks`, `/pm-channel`, or any subpath of either internal endpoint.

After a release, verify both the local runtime and public route:

```bash
/usr/local/sbin/pm-switch status
systemctl is-active pm.service pm-consumer.service agent-dashboard.service
curl -fsS -o /dev/null http://127.0.0.1:3000/login
curl -fsS -o /dev/null https://agents.eurekafiles.com/login
```

Re-run `ai/openclaw/install.sh` from the active worktree when a release changes
PM/OpenClaw unit templates, gateway hooks, or the native PM-channel plugin.
Re-run `deploy/install-pm-switch.sh` whenever a tracked switch helper changes;
updating only the Git worktree does not refresh its installed
`/usr/local/sbin` copies.

## Mail

Yoga510 does not use Gmail/Google watchers. Agent email is local-first:

- Incoming mail: `~/Maildir` via Postfix local delivery.
- Reading/listing/replying: `~/workspace/mail`, linked from the authoritative
  active-worktree source at
  `/srv/Code/environment.worktrees/main/ai/openclaw/skills/local-mail`.
- Outgoing mail: local Postfix through `/usr/sbin/sendmail -oi -t`.
- Listener service: `openclaw-mail-listener.service` writes events to `~/.openclaw/mail/events.jsonl` and wakes the agent for unread allowlisted mail through `sudo -n /usr/local/sbin/openclaw-control wake-agent <self>`.
- Sudoers: `/etc/sudoers.d/openclaw-mail-self-wake` gives `ada`, `claudia`, and `emery` permission to run only their own `wake-agent` command. Keep the broader monitor control rule separate.
- Action/reply allowlist: `skills/local-mail/auto-reply-policy.json`.
  `mail-list-inbox.js` and `mail-get-text.js` report allowlist status for senders,
  while `mail-send.js` and `mail-reply.js` refuse recipients outside the policy.
- Dispatch state is stored in `~/.openclaw/mail/dispatch-state.json`. Successful dispatches are recorded once after `openclaw-control` accepts the wake; failed dispatches are retried after the cooldown, and stale in-flight dispatches are retried after the timeout.
- Outbound email is signature-enforced by the local-mail helper. Email bodies must end with `--`, `<First name>`, and `<provider>/<model>` as defined in `WORKFLOW.md`; unsigned sends/replies are rejected.

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

Emery is allowed to send local email on yoga510 because this host uses local
Maildir for all agents and the user expects every agent to answer direct mail.
This differs from the stricter thinkpad monitor capability but keeps the same
signature and allowlist controls.

## Models and Providers

- Ada uses `openai-codex/gpt-5.5` with the thinkpad primary code-agent fallback order.
- Claudia uses Claude CLI OAuth through the normalized `anthropic/claude-opus-4-7` provider, with the thinkpad secondary code-agent fallback order.
- Emery uses the thinkpad monitoring-agent Ollama cloud fallback stack.
- All Ollama cloud entries use `http://ollama.local`, resolved locally to moonlight (`10.0.0.10`) via `/etc/hosts`.

## Telegram

Ada, Claudia, and Emery follow the thinkpad config shape: a single top-level `channels.telegram` block, not per-account `channels.telegram.accounts.*` entries. Tokens live only in per-user files:

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

Validate with `openclaw channels list` as each user, then restart `openclaw-gateway.service`, `openclaw-mail-listener.service`, and the relevant monitor webhook receivers (`openclaw-jira-receiver.service` / `openclaw-bitbucket-receiver.service`).

## Jira and Webhooks

Yoga510 now uses the thinkpad-style monitor-owned webhook dispatcher for Jira routing:

- Main local receivers: `/home/emery/webhooks/jira-receiver.js` (port `3014`) and `/home/emery/webhooks/bitbucket-receiver.js` (port `3015`).
- Routing config: `/srv/agents/index.json` via `/etc/openclaw/agents.json`.
- Routed coding users: `ada` and `claudia`.
- Task queues: `/home/ada/tasks/current.md` and `/home/claudia/tasks/current.md`.
- The monitor user has ACL write access to those task queues so incoming Jira events can be queued and agents can be woken through `/usr/local/sbin/openclaw-control`.
- Jira helpers are linked as `~/workspace/jira` and `~/.openclaw/workspace/jira` for Ada and Claudia.

Current blocker for full Jira action/reply parity: no per-agent Jira API tokens or Jira account IDs are installed on yoga510 yet. Keep `integrations.jira` and `capabilities.can_jira` false in `/srv/agents/index.json` until each coding agent has `~/.ssh/jiraToken.txt`, the registry has the correct `jira_account_id`, and the webhook secret is configured. Do not expose the Jira webhook publicly with an empty secret.

## Services

Per agent user services:

- `openclaw-gateway.service`
- `openclaw-mail-listener.service`
- `openclaw-jira-receiver.service` and `openclaw-bitbucket-receiver.service` (monitor agent only, when enabled)

Host services:

- `pm.service` on `127.0.0.1:3000` (Mission Control, runtime user `emery`)
- `pm-consumer.service` (Mission Control event consumer, runtime user `emery`)
- `agent-dashboard.service` on `127.0.0.1:3013`
- `openclaw-typing-keepalive.service`
- `openclaw-backup.timer`
- `openclaw-integrity.timer`

Gateway ports:

- Ada: `18789` loopback only
- Claudia: `18790` loopback only
- Emery: `18793` loopback only

## Validation

Run:

```bash
/usr/local/bin/openclaw-integrity-check
/usr/local/sbin/pm-switch status
systemctl is-active pm.service pm-consumer.service
```

Expected integrity result after install: `warn=0 fail=0`. Confirm all three
gateway ports listen on `127.0.0.1`/`::1`, and confirm the nginx vhosts do not
route `/hooks`, `/pm-channel`, or any subpath of either endpoint.
