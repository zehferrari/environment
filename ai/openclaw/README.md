# OpenClaw shared docs and skills

Single source of truth for OpenClaw agent operating rules and shared skill helpers. Lives under [`environment/ai/openclaw/`](../../) in the unified `environment` repo.

The contents of this folder are cloned to the host checkout (x1: **`/srv/Code/environment/ai/openclaw/`**; yoga510: **`/home/rachael/Code/environment/ai/openclaw/`**). Every agent reads from it through symlinks; every edit goes through git.

For broader context:
- Host inventory (x1 / moonlight / thinkpad) → [`../../README.md`](../../README.md)
- Deep host doc for x1 (network, services, monitoring, recent changes) → [`../README.md`](../README.md)
- Agent dashboard frontend → [`../web/agents.html`](../web/agents.html)

## Layout

```
.
├── README.md              this file (folder overview, layout, editing)
├── AGENT_FILES.md         per-agent files (NOT in this repo) and what each is for
├── ENVIRONMENT.md         "where things live" map (source of truth + policy)
├── SERVICES.md            service catalog
├── MONITORING.md          monitoring topology overview
├── AGENTS.md              shared agent operating manual (every agent reads it)
├── ROLES.md               role-specific behaviour (manager / developer / monitor)
├── TEAM_WORKFLOW.md       canonical workflow rules — symlinked into every agent's workspace
├── CODE_REPOS.md          shared /srv/Code/ project repos + mandatory branch workflow
├── index.example.json     agent registry template (single record) — copy to /srv/agents/index.json (live, NOT in repo) and edit
└── skills/
    ├── agent-self.js      registry-driven identity resolver (reads /etc/openclaw/agents.json by os.userInfo().username)
    ├── jira/              Jira API helpers (jira-comment.js, jira-transition.js, lib.js, …)
    ├── google-workspace/  Gmail/Drive/Docs/Calendar/Photos helpers (gmail-send.js, mime.js, …)
    └── local-mail/        yoga510 Maildir/Postfix helpers and allowlist policy
```

The split between `AGENTS.md` and `ROLES.md` is deliberate: every agent reads the
**same** `AGENTS.md` (operating baseline) regardless of role, then resolves its
`role` from `agents.json` and reads the matching section in `ROLES.md`. One
unique source per concern: identity baseline (`AGENTS.md`), role behaviour
(`ROLES.md`), task workflow (`TEAM_WORKFLOW.md`).

## How agents see this repo

Per-agent symlinks point into the host-specific OpenClaw checkout. Use `/srv/Code/environment/ai/openclaw` on x1 and `/home/rachael/Code/environment/ai/openclaw` on yoga510.

| Agent path | → target |
|---|---|
| `/home/<user>/workspace/AGENTS.md` | `<openclaw-root>/AGENTS.md` (single shared file for every agent) |
| `/home/<user>/.openclaw/workspace/AGENTS.md` | same |
| `/home/<user>/workspace/ROLES.md` | `<openclaw-root>/ROLES.md` |
| `/home/<user>/.openclaw/workspace/ROLES.md` | same |
| `/home/<user>/workspace/TEAM_WORKFLOW.md` | `<openclaw-root>/TEAM_WORKFLOW.md` |
| `/home/<user>/.openclaw/workspace/TEAM_WORKFLOW.md` | same |
| `/home/<user>/.openclaw/workspace/jira/*.js` | `<openclaw-root>/skills/jira/` |
| `/home/<user>/.openclaw/skills/google-workspace/*.js` | `<openclaw-root>/skills/google-workspace/` |
| `/home/<user>/workspace/mail/*.js` | `<openclaw-root>/skills/local-mail/` on yoga510 |
| `/etc/openclaw/agents.json` | `/srv/agents/index.json` (live runtime registry, NOT in this repo — edited by the dashboard's POST /agents/registry/toggle; see [`index.example.json`](./index.example.json) for the template) |

Note: the `monitoring` agent (Linux user `karen`) has only the
`~/.openclaw/workspace/` paths — the user-facing `~/workspace/` doesn't exist
for that role, so AGENTS/ROLES/TEAM_WORKFLOW are symlinked once each there.

Per-agent **state**, **identity**, **tokens**, and **memory** are NOT symlinked and NOT in this repo — see [`AGENT_FILES.md`](./AGENT_FILES.md).

On yoga510, local-mail is shared code and policy. The allowlist lives at
`skills/local-mail/auto-reply-policy.json`; list/read helpers expose allowlist
status, and send/reply helpers block recipients outside that policy.

## Editing

Edit any file under the host checkout, commit, push. Use `/srv/Code/environment/ai/openclaw` on x1 and `/home/rachael/Code/environment/ai/openclaw` on yoga510. Every agent picks up the new content on the next read.

The working tree is owned by a single configured user (the **git owner**) so git operations don't need sudo for that user. Files are world-readable so all consumers (root, the monitoring agent, every coding agent) can read.

```bash
# Resolve the git owner dynamically from the working tree's ownership:
OWNER=$(stat -c %U /srv/Code/environment/ai/openclaw)

cd /srv/Code/environment/ai/openclaw
sudo -u "$OWNER" git pull
# edit files
sudo -u "$OWNER" git commit -am "<message>"
sudo -u "$OWNER" git push
```

## Agent identity in code

Helper modules under `skills/` MUST NOT hardcode agent-specific constants (email, displayName, accountId). They resolve identity at runtime via `skills/agent-self.js`, which looks up the running user in the registry at `/etc/openclaw/agents.json` (symlink → `/srv/agents/index.json`):

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
