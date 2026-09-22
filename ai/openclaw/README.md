# OpenClaw shared docs and skills

Single source of truth for OpenClaw agent operating rules and shared skill helpers. Lives under [`environment/ai/openclaw/`](../../) in the unified `environment` repo.

The contents of this folder are cloned to the host checkout. On thinkpad, feature
work happens only in **`/srv/Code/environment.worktrees/<branch>/ai/openclaw/`**;
do not edit the primary `/srv/Code/environment/` checkout. Every agent reads
from files reconciled from the active OpenClaw install; every edit goes through git.

For broader context:
- Host inventory (thinkpad / moonlight / x1) → [`../../README.md`](../../README.md)
- Deep host doc for thinkpad (network, services, monitoring, recent changes) → [`../README.md`](../README.md)
- Agent dashboard frontend → [`../web/agents.html`](../web/agents.html)

## Layout

```
.
├── README.md              this file (folder overview, layout, editing)
├── install.sh             host bootstrap/reconcile script for OpenClaw services and PM wake hooks
├── AGENT_FILES.md         per-agent files (NOT in this repo) and what each is for
├── ENVIRONMENT.md         "where things live" map (source of truth + policy)
├── AGENTS.md              shared agent operating manual (every agent reads it)
├── WORKFLOW.md            canonical workflow rules — symlinked into every agent's workspace
├── index.example.json     agent registry template (single record) — copy to /etc/openclaw/agents.json (live, NOT in repo) and edit
├── guides/
│   ├── ROLES.md           task-role behaviour for coding agents + monitor role
│   ├── SERVICES.md        service catalog
│   ├── MONITORING.md      monitoring topology overview
│   ├── CODE_REPOS.md      shared /srv/Code/ project repos + mandatory branch workflow
│   ├── INCIDENT_HANDLING.md  Monitor Agent incident triage protocol
│   ├── JIRA.md            Jira-specific workflow (comments, mentions, queue, assignment, working a ticket)
│   ├── BITBUCKET.md       Bitbucket-specific workflow (branches, commits, Smart Commits, review, PR boundary)
│   └── MISSION_CONTROL.md Mission Control / ai/web PM interface guide (routes, tabs, fields, agent runtime contract)
└── skills/
    ├── agent-self.js      registry-driven identity resolver (reads /etc/openclaw/agents.json by os.userInfo().username)
    ├── jira/              Jira API helpers (jira-comment.js, jira-transition.js, lib.js, …)
    ├── google-workspace/  Gmail/Drive/Docs/Calendar/Photos helpers (gmail-send.js, mime.js, …)
    └── local-mail/        yoga510 Maildir/Postfix helpers and allowlist policy
```

The split between `AGENTS.md` and `guides/ROLES.md` is deliberate: every agent reads the
**same** `AGENTS.md` (operating baseline). Coding agents then use `guides/ROLES.md` to
map the live ticket/Epic context to a task role; `manager` and `developer` are
not standing personas. `monitor` remains a standing operational role resolved
from the active agent registry.
One unique source per concern: identity baseline (`AGENTS.md`), task-role
behaviour (`guides/ROLES.md`), task workflow (`WORKFLOW.md`).

The versioned `bin/claim-branch` helper is installed by `install.sh` as
`/usr/local/bin/claim-branch`; it is the only supported way for agents to
create or attach shared repository worktrees. Mission Control reserves the
branch contract when an Action Plan is approved, then invokes the helper
through the repository runner when the task enters In Progress.

## How agents see this repo

Per-agent symlinks point into the active OpenClaw checkout that ran
`ai/openclaw/install.sh`. On worktree-based deployments, that means the active
worktree checkout, not a stale main checkout.

| Agent path | → target |
|---|---|
| `/home/<user>/workspace/AGENTS.md` | `<openclaw-root>/AGENTS.md` (single shared file for every agent) |
| `/home/<user>/.openclaw/workspace/AGENTS.md` | same |
| `/home/<user>/workspace/ROLES.md` | `<openclaw-root>/guides/ROLES.md` |
| `/home/<user>/.openclaw/workspace/ROLES.md` | same |
| `/home/<user>/{workspace,.openclaw/workspace}/guides/ROLES.md` | same; canonical-path alias used by links inside `AGENTS.md` and `WORKFLOW.md` |
| `/home/<user>/workspace/WORKFLOW.md` | `<openclaw-root>/WORKFLOW.md` |
| `/home/<user>/.openclaw/workspace/WORKFLOW.md` | same |
| `/home/<user>/workspace/CODE_REPOS.md` | `<openclaw-root>/guides/CODE_REPOS.md` |
| `/home/<user>/.openclaw/workspace/CODE_REPOS.md` | same |
| `/home/<user>/{workspace,.openclaw/workspace}/guides/CODE_REPOS.md` | same; canonical-path alias used by linked workflow guidance |
| `/home/<user>/.openclaw/workspace/jira/*.js` | `<openclaw-root>/skills/jira/` |
| `/home/<user>/.openclaw/skills/google-workspace/*.js` | `<openclaw-root>/skills/google-workspace/` |
| `/home/<user>/workspace/mail/*.js` | `<openclaw-root>/skills/local-mail/` on yoga510 |
| `/etc/openclaw/agents.json` | Live runtime registry, NOT in this repo; historical installs may symlink it to `/srv/agents/index.json`. Enable/disable flips come from the dashboard's `POST /agents/registry/toggle`; **agent create/edit/remove** are written by the root `/usr/local/sbin/openclaw-manage-user` helper ([`bin/openclaw-manage-user`](./bin/openclaw-manage-user)), driven by the PM webapp's `/api/agents/*` routes — see [`../THINKPAD.md`](../THINKPAD.md) § Agent Lifecycle Management. Template: [`index.example.json`](./index.example.json). |
| `/home/<user>/workspace/{SOUL,USER,MEMORY,IDENTITY,TOOLS,HEARTBEAT}.md` | `<agentFilesRoot>/<user>/...` per-agent private files |
| `/home/<user>/.openclaw/workspace/{SOUL,USER,MEMORY,IDENTITY,TOOLS,HEARTBEAT}.md` | same |
| `/home/<user>/.openclaw/openclaw.json` | Regular `0600` runtime copy of PM-owned `<agentFilesRoot>/<user>/openclaw.json` |

Note: the monitor agent has only the `~/.openclaw/workspace/` paths. The
user-facing `~/workspace/` may not exist for monitor users, so
AGENTS/ROLES/WORKFLOW are symlinked once each there.

Per-agent **identity**, **memory**, and the canonical **OpenClaw runtime config**
live under the host's private agent-files root, defaulting to `/srv/agents/openclaw`
and overrideable with `agentFilesRoot` in `/etc/openclaw/agents.json`. The active
OpenClaw config is a reconciled regular copy because OpenClaw's atomic writers
do not support symlink configs. Per-agent **state** and **tokens** still live
under each agent's home and are NOT in this repo — see
[`AGENT_FILES.md`](./AGENT_FILES.md).

On yoga510, local-mail is shared code and policy. The allowlist lives at
`skills/local-mail/auto-reply-policy.json`; list/read helpers expose allowlist
status, and send/reply helpers block recipients outside that policy.

## Editing

Edit files in a branch/worktree checkout, commit, push, then deploy/reconcile
that worktree. On thinkpad use `/srv/Code/environment.worktrees/<branch>/ai/openclaw`;
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

Run `install.sh` after pulling changes on thinkpad. Besides syncing scripts and
systemd units, it reconciles the PM web/OpenClaw integration when the
sibling PM checkout exists. The PM step creates `/var/lib/pm/drop`,
renders the one host-wide `pm.service` and `pm-consumer.service`, binds
every enabled agent gateway to loopback, enables its external
`/hooks/wake` surface for non-chat PM events, installs the native
OpenClaw `pm` channel plugin for every enabled registry agent, and mirrors token maps into
`/etc/openclaw/pm-consumer-tokens.json` and
`/etc/openclaw/pm-channel-tokens.json`.
It also reconciles every enabled agent to the host-managed Chromium policy:
`browser.enabled=true`, `/usr/bin/chromium`, headless operation, sandbox
retained, and the `openclaw` default profile. Install the host `chromium`
package before running the reconcile. The executable is shared; each agent's
profile remains private under `~/.openclaw/browser/openclaw/user-data`.
The same reconcile enforces safeguard compaction with
`agents.defaults.compaction.reserveTokensFloor=50000`. Mission Control task
sessions are long-lived; this reserve lets OpenClaw recover the turn instead
of emitting a terminal auto-compaction failure after productive work.
For PM-driven agent add/edit, the web route passes the active PM worktree as
the helper payload `repoRoot`; the helper validates that it is under
`/srv/Code/environment.worktrees/<name>` before using it for doc symlinks,
sudoers, `install.sh`, and PM-channel scripts.
The helper also creates `/srv/agents/Pictures/<Username>` with `code-agents`
group-write permissions so PM manual uploads and agent-generated profile images
can write `profile.png` and `avatar.png`.

The installer also runs `/usr/local/sbin/openclaw-patch-session-fence`
against the installed OpenClaw runtime. OpenClaw 2026.5.22 needs the local
compatibility patch so provider-timeout records written during a PM channel
turn are not misclassified as an external session takeover. Newer OpenClaw
releases own and merge prompt-time transcript writes upstream; the helper
detects that implementation and exits successfully without modifying the
package. Re-run `install.sh` after upgrading, reinstalling, or rolling back
the global `openclaw` package.

Gateway hook config lives canonically in
`/srv/agents/openclaw/<agent>/openclaw.json`. The active
`/home/<agent>/.openclaw/openclaw.json` is a regular `0600` copy. PM-triggered
gateway restarts sync it first; `openclaw-config-sync.path` reacts to every
canonical change; and `openclaw-doc-sync.timer` provides a five-minute fallback.
`ai-monitor` checks regular-file content equality and reports
`agent-config-drift` only when reconciliation has genuinely failed.
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

### Local managed-browser navigation (OpenClaw 2026.9.3)

For an owner-approved loopback fixture, add the exact host to the individual
agent's canonical `browser.ssrfPolicy.allowedHostnames`; retain
`dangerouslyAllowPrivateNetwork=false` and `browser.noSandbox=false`. Host
exceptions cover all ports on that host, not one URL path. Apply through the
host `openclaw-config-sync.service` and restart the affected idle gateway.

This release's direct `browser open <http URL>` can refuse with “strict browser
SSRF policy requires Playwright-backed redirect-hop inspection” even with a
valid host exception. Use the managed tool to open `about:blank`, then navigate
that returned target to the authorized URL. `navigate` performs Playwright
redirect checks. Verify with a DOM snapshot before resuming the task; do not
switch to an unmanaged browser or direct CDP to evade a policy denial.
