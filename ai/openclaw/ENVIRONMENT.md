# Where things live

A quick map for finding the right place to look or to edit. For the host
inventory itself, see [`../../README.md`](../../README.md).

## Source of truth

| For… | Look at |
|---|---|
| **Active agent roster** (user, role, email, accountId, capabilities, integrations, services, listeners) | `/etc/openclaw/agents.json` → `/srv/agents/index.json` (live runtime, NOT in this repo; the dashboard writes capability/integration toggles back to it). [`index.example.json`](./index.example.json) is the in-repo single-record template. |
| **Workflow rules** (Jira, email, Telegram, formatting, signature, escalation, picking next task) | [`TEAM_WORKFLOW.md`](./TEAM_WORKFLOW.md) |
| **Agent operating baseline** (every agent) | [`AGENTS.md`](./AGENTS.md) |
| **Role-specific behaviour** (manager / developer / monitor) | [`ROLES.md`](./ROLES.md) |
| **Shared skill helpers** (Jira, Gmail/Drive, agent-self) | [`skills/`](./skills/) |
| **Host topology, services, network, monitoring detail, recent changes** | [`../README.md`](../README.md) |
| **Service catalog** | [`SERVICES.md`](./SERVICES.md) |
| **Monitoring topology** | [`MONITORING.md`](./MONITORING.md) |
| **Per-agent files (NOT in this repo)** | [`AGENT_FILES.md`](./AGENT_FILES.md) |
| **Webhook routing only** (Jira/Bitbucket → coding agent) | `/home/karen/webhooks/users.json` (per-host, not in this repo) |

## Policy

- **Persona and private memory stay per-agent.** This repo holds only stable
  shared knowledge: hosts, services, ports, monitoring, workflow, role
  baselines, integration rules.
- **Identity and runtime config flow through the registry.** Helpers must
  resolve agent identity at runtime via `skills/agent-self.js`, never
  hardcode email/displayName/accountId.
- **`Backlog` Jira tickets are ignored** unless zeh explicitly overrides for
  that specific ticket.
- **Edits go through git.** Edit a file in `/srv/agents/shared/`, commit,
  push. Every agent picks up the change on next read.
