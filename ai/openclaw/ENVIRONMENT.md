# Where things live

A quick map for finding the right place to look or to edit. For the host
inventory itself, see [`../../README.md`](../../README.md).

## Source of truth

| For… | Look at |
|---|---|
| **Active agent roster** (user, role, email, accountId, capabilities, integrations, services, listeners) | `/etc/openclaw/agents.json` → `/srv/agents/index.json` (live runtime, NOT in this repo; the dashboard writes capability/integration toggles back to it). [`index.example.json`](./index.example.json) is the in-repo single-record template. |
| **Per-agent private identity/memory/config files** (`SOUL`, `USER`, `MEMORY`, `IDENTITY`, `TOOLS`, `HEARTBEAT`, `openclaw.json`) | Top-level `agentFilesRoot` in `/etc/openclaw/agents.json`, default `/srv/agents/openclaw`; workspace/config paths symlink back to `<agentFilesRoot>/<user>/`. |
| **Workflow rules** (Jira, email, Telegram, formatting, signature, escalation, picking next task) | [`WORKFLOW.md`](./WORKFLOW.md) |
| **Agent operating baseline** (every agent) | [`AGENTS.md`](./AGENTS.md) |
| **Role-specific behaviour** (manager / developer / monitor) | [`guides/ROLES.md`](./guides/ROLES.md) |
| **Shared skill helpers** (Jira, Gmail/Drive, agent-self) | [`skills/`](./skills/) |
| **Host topology, services, network, monitoring detail, recent changes** | [`../README.md`](../README.md) |
| **yoga510 agent install** (Maildir/Postfix agent host mapping and validation) | [`YOGA510.md`](./YOGA510.md) |
| **Service catalog** | [`guides/SERVICES.md`](./guides/SERVICES.md) |
| **Monitoring topology** | [`guides/MONITORING.md`](./guides/MONITORING.md) |
| **Per-agent files (NOT in this repo)** | [`AGENT_FILES.md`](./AGENT_FILES.md) |
| **Webhook routing** (Jira/Bitbucket → coding agent) | `/srv/agents/index.json` via `/etc/openclaw/agents.json` |

## Policy

- **Persona and private memory stay per-agent.** This repo holds only stable
  shared knowledge: hosts, services, ports, monitoring, workflow, role
  baselines, integration rules. `install.sh` keeps private persona, memory,
  and OpenClaw runtime config files under the host agent-files root and
  symlinks them into each agent workspace/config path.
- **Identity and runtime config flow through the registry.** Helpers must
  resolve agent identity at runtime via `skills/agent-self.js`, never
  hardcode email/displayName/accountId.
- **`Backlog` Jira tickets are ignored** unless zeh explicitly overrides for
  that specific ticket.
- **Edits go through git.** Edit the host checkout (x1: `/srv/Code/environment/ai/openclaw/`; yoga510: `/home/rachael/Code/environment/ai/openclaw/`), commit,
  push. Every agent picks up the change on next read.
- **No Claude / Anthropic attribution in commits, PRs, or anything else.**
  If a host enables Anthropic / Claude (e.g. an agent runs Claude Code, or a
  human uses Claude Code on the host), ensure the `Co-Authored-By: Claude`
  trailer and the `🤖 Generated with Claude Code` PR footer stay OFF. Set
  both in `~/.claude/settings.json` (and any project-local
  `.claude/settings.json` / `.claude/settings.local.json`):
  ```json
  {
    "attribution": { "commit": "", "pr": "" },
    "includeCoAuthoredBy": false
  }
  ```
  Empty `attribution.commit` / `attribution.pr` hide each one; the deprecated
  `includeCoAuthoredBy: false` covers older Claude Code versions. Audit
  every settings file on a fresh install — repo commits attribute to the
  human user only.
