# OpenClaw shared docs and skills

Single source of truth for OpenClaw agent operating rules and shared skill helpers. Lives under [`environment/ai/openclaw/`](../../) in the unified `environment` repo.

The contents of this folder are cloned to the host checkout. On x1, feature
work happens only in **`/srv/Code/environment.worktrees/<branch>/ai/openclaw/`**;
do not edit the primary `/srv/Code/environment/` checkout. Every agent reads
from the active OpenClaw install through symlinks; every edit goes through git.

For broader context:
- Host inventory (x1 / moonlight / thinkpad) → [`../../README.md`](../../README.md)
- Deep host doc for x1 (network, services, monitoring, recent changes) → [`../README.md`](../README.md)
- Agent dashboard frontend → [`../web/agents.html`](../web/agents.html)

## Layout

```
.
├── README.md              this file (folder overview, layout, editing)
├── install.sh             host bootstrap/reconcile script for OpenClaw services and PM wake hooks
├── AGENT_FILES.md         per-agent files (NOT in this repo) and what each is for
├── ENVIRONMENT.md         "where things live" map (source of truth + policy)
├── SERVICES.md            service catalog
├── MONITORING.md          monitoring topology overview
├── AGENTS.md              shared agent operating manual (every agent reads it)
├── ROLES.md               task-role behaviour for coding agents + monitor role
├── TEAM_WORKFLOW.md       canonical workflow rules — symlinked into every agent's workspace
├── CODE_REPOS.md          shared /srv/Code/ project repos + mandatory branch workflow
├── index.example.json     agent registry template (single record) — copy to /etc/openclaw/agents.json (live, NOT in repo) and edit
└── skills/
    ├── agent-self.js      registry-driven identity resolver (reads /etc/openclaw/agents.json by os.userInfo().username)
    ├── jira/              Jira API helpers (jira-comment.js, jira-transition.js, lib.js, …)
    ├── google-workspace/  Gmail/Drive/Docs/Calendar/Photos helpers (gmail-send.js, mime.js, …)
    └── local-mail/        yoga510 Maildir/Postfix helpers and allowlist policy
```

The split between `AGENTS.md` and `ROLES.md` is deliberate: every agent reads the
**same** `AGENTS.md` (operating baseline). Coding agents then use `ROLES.md` to
map the live ticket/Epic context to a task role; `manager` and `developer` are
not standing personas. `monitor` remains a standing operational role for Karen.
One unique source per concern: identity baseline (`AGENTS.md`), task-role
behaviour (`ROLES.md`), task workflow (`TEAM_WORKFLOW.md`).

## How agents see this repo

Per-agent symlinks point into the active OpenClaw checkout that ran
`ai/openclaw/install.sh`. On worktree-based deployments, that means the active
worktree checkout, not a stale main checkout.

| Agent path | → target |
|---|---|
| `/home/<user>/workspace/AGENTS.md` | `<openclaw-root>/AGENTS.md` (single shared file for every agent) |
| `/home/<user>/.openclaw/workspace/AGENTS.md` | same |
| `/home/<user>/workspace/ROLES.md` | `<openclaw-root>/ROLES.md` |
| `/home/<user>/.openclaw/workspace/ROLES.md` | same |
| `/home/<user>/workspace/TEAM_WORKFLOW.md` | `<openclaw-root>/TEAM_WORKFLOW.md` |
| `/home/<user>/.openclaw/workspace/TEAM_WORKFLOW.md` | same |
| `/home/<user>/workspace/CODE_REPOS.md` | `<openclaw-root>/CODE_REPOS.md` |
| `/home/<user>/.openclaw/workspace/CODE_REPOS.md` | same |
| `/home/<user>/.openclaw/workspace/jira/*.js` | `<openclaw-root>/skills/jira/` |
| `/home/<user>/.openclaw/skills/google-workspace/*.js` | `<openclaw-root>/skills/google-workspace/` |
| `/home/<user>/workspace/mail/*.js` | `<openclaw-root>/skills/local-mail/` on yoga510 |
| `/etc/openclaw/agents.json` | Live runtime registry, NOT in this repo; historical installs may symlink it to `/srv/agents/index.json`. Enable/disable flips come from the dashboard's `POST /agents/registry/toggle`; **agent create/edit/remove** are written by the root `/usr/local/sbin/openclaw-manage-user` helper ([`bin/openclaw-manage-user`](./bin/openclaw-manage-user)), driven by the PM webapp's `/api/agents/*` routes — see [`../X1.md`](../X1.md) § Agent Lifecycle Management. Template: [`index.example.json`](./index.example.json). |
| `/home/<user>/workspace/{SOUL,USER,MEMORY,IDENTITY,TOOLS,HEARTBEAT}.md` | `<agentFilesRoot>/<user>/...` per-agent private files |
| `/home/<user>/.openclaw/workspace/{SOUL,USER,MEMORY,IDENTITY,TOOLS,HEARTBEAT}.md` | same |
| `/home/<user>/.openclaw/openclaw.json` | `<agentFilesRoot>/<user>/openclaw.json` per-agent runtime config, agent-owned and writable by the configured `codeGroup` |

Note: the monitor agent has only the `~/.openclaw/workspace/` paths. The
user-facing `~/workspace/` may not exist for monitor users, so
AGENTS/ROLES/TEAM_WORKFLOW are symlinked once each there.

Per-agent **identity**, **memory**, and **OpenClaw runtime config** are
symlinked to the host's private agent-files root, defaulting to
`/srv/agents/openclaw` and overrideable with `agentFilesRoot` in
`/etc/openclaw/agents.json`. Per-agent **state** and **tokens** still live
under each agent's home and are NOT in this repo — see
[`AGENT_FILES.md`](./AGENT_FILES.md).

On yoga510, local-mail is shared code and policy. The allowlist lives at
`skills/local-mail/auto-reply-policy.json`; list/read helpers expose allowlist
status, and send/reply helpers block recipients outside that policy.

## Editing

Edit files in a branch/worktree checkout, commit, push, then deploy/reconcile
that worktree. On x1 use `/srv/Code/environment.worktrees/<branch>/ai/openclaw`;
do not edit `/srv/Code/environment/` directly. On yoga510 use
`/home/rachael/Code/environment/ai/openclaw`. Every agent picks up the new
content on the next read after its symlinks point at the active install.

The working tree is owned by a single configured user (the **git owner**) so git operations don't need sudo for that user. Files are world-readable so all consumers (root, the monitoring agent, every coding agent) can read.

```bash
# Resolve the git owner dynamically from the working tree's ownership:
OWNER=$(stat -c %U /srv/Code/environment.worktrees/<branch>/ai/openclaw)

cd /srv/Code/environment.worktrees/<branch>/ai/openclaw
sudo -u "$OWNER" git pull
# edit files
sudo -u "$OWNER" git commit -am "<message>"
sudo -u "$OWNER" git push
```

## Host install path

Run `install.sh` after pulling changes on x1. Besides syncing scripts and
systemd units, it reconciles the PM web/OpenClaw integration when the
sibling PM checkout exists. The PM step creates `/var/lib/pm/drop`,
renders the one host-wide `pm.service` and `pm-consumer.service`, binds
every enabled agent gateway to loopback, enables its external
`/hooks/wake` surface for non-chat PM events, installs the native
OpenClaw `pm` channel plugin for every enabled registry agent, and mirrors token maps into
`/etc/openclaw/pm-consumer-tokens.json` and
`/etc/openclaw/pm-channel-tokens.json`.
For PM-driven agent add/edit, the web route passes the active PM worktree as
the helper payload `repoRoot`; the helper validates that it is under
`/srv/Code/environment.worktrees/<name>` before using it for doc symlinks,
sudoers, `install.sh`, and PM-channel scripts.

The installer also runs `/usr/local/sbin/openclaw-patch-session-fence`
against the installed OpenClaw runtime. That patch keeps provider timeout
records written during a PM channel turn from being misclassified as an
external session takeover, so OpenClaw can continue into the configured
model fallback chain instead of returning a generic PM failure. Re-run
`install.sh` after upgrading or reinstalling the global `openclaw`
package.

Gateway hook config lives in `/srv/agents/openclaw/<agent>/openclaw.json`;
`/home/<agent>/.openclaw/openclaw.json` should be a symlink to that
canonical file so Mission Control writes and the gateway runtime read the
same config. `install.sh` verifies that link and refuses to replace a
different regular home file until an operator reconciles the two copies.
`gateway.bind="loopback"`, `gateway.trustedProxies=["127.0.0.1","::1"]`,
`gateway.auth.trustedProxy.allowLoopback=true`, `hooks.enabled=true`,
`hooks.path="/hooks"`, `hooks.token=<secret>`,
`hooks.allowRequestSessionKey=true`, and
`hooks.allowedSessionKeyPrefixes=["hook:","pm:"]`. OpenClaw requires
`hook:` when no hook default session key is configured; PM-owned session
keys use the `pm:` prefix. Direct chat keeps a stable `pm:` key, while
Task/Epic Discussion and task-comment turns derive per-message `pm:`
keys from the PM binding. Chat, Epic chat, and task-comment turns
normally enter OpenClaw through `POST /pm-channel/ingest`, not
`/hooks/wake`. The PM app sends a final reply callback
(`/api/openclaw/pm-channel/reply`) and a live partial-reply stream
callback (`/api/openclaw/pm-channel/stream`) in each native channel turn.
PM also stores a durable `PmChannelRun` row for each native channel turn
so browser reconnects can resume from accepted/streaming/failed state
without relying on `/hooks/wake` or polling.
The installer preserves `hooks.internal` and
restarts `openclaw-gateway.service` when it changes hook or channel
config. The PM-channel installer waits for the restarted
`openclaw-gateway.service` to report `active` so provisioning fails loudly if a
new or edited agent cannot come online. Do not expose hooks or the PM channel
through nginx; PM calls them on `127.0.0.1`. Any nginx dashboard proxy for the
gateway must use
`127.0.0.1:<gateway_port>` as the upstream, not the host's LAN IP, and
must explicitly block prefixed paths such as `/<agent>/hooks` and
`/<agent>/pm-channel`.

## Agent identity in code

Helper modules under `skills/` MUST NOT hardcode agent-specific constants
(email, displayName, accountId). They resolve identity at runtime via
`skills/agent-self.js`, which looks up the running user in the registry at
`/etc/openclaw/agents.json`:

```javascript
const self = require('../agent-self');
console.log(self.email, self.firstName, self.jiraAccountId);
```

This is why the same `lib.js` works for every registered coding agent.

## What does NOT belong in here

- Per-agent persona, memory, or session state
- API tokens, OAuth credentials, secrets — `.gitignore` blocks `.env*` and similar; never commit a token
- Backup files (`*.bak`) — git history is the backup
- Agent-specific runtime state (gmail watch state, comment dedupe ledgers, etc.)

See [`AGENT_FILES.md`](./AGENT_FILES.md) for the full per-agent inventory.
