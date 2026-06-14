# Per-agent unique files

These files stay separate for each registered coding agent. Each lives under `/home/<user>/`. The shared repo deliberately does not version-control them.

> **How they're created.** When an agent is added through the PM webapp (Agents
> → `Add Agent`), the root `openclaw-manage-user` helper scaffolds the per-agent
> files (`SOUL`, `IDENTITY`, `TOOLS`, `MEMORY`, `HEARTBEAT`, `openclaw.json`)
> into the agent-files root `/srv/agents/openclaw/<user>/` from templates
> rendered by `ai/web/lib/agents/provisioning.ts`, and points
> `~/.openclaw/openclaw.json` at the canonical copy by symlink. Editing the
> agent re-renders them. See [`../X1.md`](../X1.md) § Agent Lifecycle Management.

## Identity & persona — `~/workspace/*.md`

`AGENTS.md`, `ROLES.md`, `TEAM_WORKFLOW.md`, `CODE_REPOS.md`, and `USER.md` are **shared by every agent** and live in this repo. The remaining files (`SOUL`, `IDENTITY`, `TOOLS`, `MEMORY`, `HEARTBEAT`) are **per-agent in content** but **single-canonical in location**: each lives once at `~/workspace/<file>` and `~/.openclaw/workspace/<file>` is a symlink to it, so no matter which workspace path the runtime reads, it sees the same file.

| File | Source of truth | Purpose |
|---|---|---|
| `AGENTS.md` | active OpenClaw checkout that ran `ai/openclaw/install.sh` (`<openclaw-root>/AGENTS.md`) | **Shared baseline for every agent.** Both `~/workspace/AGENTS.md` and `~/.openclaw/workspace/AGENTS.md` symlink to the repo file. |
| `ROLES.md` | active OpenClaw checkout that ran `ai/openclaw/install.sh` (`<openclaw-root>/ROLES.md`) | Role-specific behaviour (`## Manager`, `## Developer`, `## Monitor`). Agent identifies its role from `agents.json` and reads the matching section. Same symlink pattern as `AGENTS.md`. |
| `TEAM_WORKFLOW.md` | active OpenClaw checkout that ran `ai/openclaw/install.sh` (`<openclaw-root>/TEAM_WORKFLOW.md`) | Action-indexed workflow playbook. Same symlink pattern. |
| `CODE_REPOS.md` | active OpenClaw checkout that ran `ai/openclaw/install.sh` (`<openclaw-root>/CODE_REPOS.md`) | Shared-code workflow for `/srv/Code`, `claim-branch`, git identity, and the human-only PR boundary. Same symlink pattern. |
| `USER.md` | active OpenClaw checkout that ran `ai/openclaw/install.sh` (`<openclaw-root>/USER.md`) | **Shared by every agent.** Information about the user (Zeh), their timezone, and preferences. Same symlink pattern as `AGENTS.md`. |
| `SOUL.md` | `~/workspace/SOUL.md` (per-agent, not in this repo) | Personality, tone, decision-making heuristics. Free-form, agent-specific. |
| `IDENTITY.md` | `~/workspace/IDENTITY.md` (per-agent) | Core "who am I" preamble loaded on every session start. |
| `TOOLS.md` | `~/workspace/TOOLS.md` (per-agent) | Notes on the agent's own tool usage habits. |
| `MEMORY.md` | `~/workspace/MEMORY.md` (per-agent) | Long-running per-agent memory (project history, recurring topics, pending follow-ups). |
| `HEARTBEAT.md` | `~/workspace/HEARTBEAT.md` (per-agent) | Liveness marker / last-tick state. |

The monitor agent only has `~/.openclaw/workspace/`, no user-facing
`~/workspace/`, so its per-agent files live there directly.

## Authentication & secrets — `~/.ssh/`, `~/.config/`

**Never** commit any of these to git.

| Path | Purpose |
|---|---|
| `~/.ssh/jiraToken.txt` | Atlassian API token used by `skills/jira/lib.js` for Jira REST calls. |
| `~/.ssh/bitbucketToken.txt` | Bitbucket API/app token for `git push` (HTTPS) or repo API calls. |
| `~/.ssh/id_*` | Per-agent SSH key pair (Bitbucket, optional GitHub). |
| `~/.config/openclaw/openclaw-secrets.env` | Telegram bot token, OpenClaw gateway token, model-provider API keys (Moonshot, Z.ai). |
| `~/.config/openclaw/openclaw-webhook.env` | Webhook signing secrets (Jira, Bitbucket). |
| `/srv/agents/openclaw/<agent>/openclaw.json` | Canonical per-agent OpenClaw runtime config (model defaults, gateway hooks, limits). `/home/<agent>/.openclaw/openclaw.json` should symlink here so Mission Control and the gateway runtime share one file. |
| `~/.local/share/openclaw/...` | OAuth refresh tokens for Gmail, Drive, Calendar, Photos. |

## Per-agent runtime state — `~/.openclaw/skills/google-workspace/*.json`

These files are read AND written by each agent's gmail/drive/docs flows. Sharing them would cause double-handling or missed events.

| File | Purpose |
|---|---|
| `state.json` | gmail-listener cursor + per-thread state. |
| `push-state.json` | Gmail push-notification subscription state. |
| `watch-state.json` | Gmail watch renewal expiry tracking. |
| `docs-comment-state.json` | Google Docs comments dedupe ledger (which comment IDs have been replied to). |
| `drive-comment-state.json` | Drive file comments dedupe ledger. |
| `_comments.json`, `_docs.json` | Cached resource lookups. |
| `auto-reply-policy.json` | Per-agent auto-reply policy (which senders, what tone). |

On yoga510, local Maildir email does not use the Google workspace state path.
Its shared allowlist policy is versioned in the repo at
`skills/local-mail/auto-reply-policy.json` and is used by every local-mail
symlink (`/home/{ada,claudia,emery}/workspace/mail`). All local agents with
email access should be present in that allowlist so they can action and reply to
mail sent by another local agent.

## Sessions, logs, and task state — `~/.openclaw/agents/`, `~/tasks/`

| Path | Purpose |
|---|---|
| `~/.openclaw/agents/main/sessions/*.jsonl` | Live agent session transcripts (the runtime "what the agent has said and done"). |
| `~/tasks/current.md` | Current Jira task notes. Append-only working log. |
| `~/tasks/log.md` | Action history. |

## Code workspaces — `~/Code/`

On x1, `~/Code` should be a symlink to the shared `/srv/Code` tree. Agents
claim isolated branches through `/srv/Code/environment.worktrees/<branch>/`
instead of using private per-agent checkouts. During provisioning/update,
`openclaw-manage-user` repairs missing file/symlink targets, but it will not
delete a non-empty `~/Code` directory just to create the symlink; that condition
should be treated as an operational drift item and fixed deliberately.

## Webhook routing — `/srv/agents/index.json`

The live agent registry is the only routing source. Jira routes to enabled coding agents with `integrations.jira: true` and a `jira_account_id`; Bitbucket routes to enabled coding agents with `integrations.bitbucket: true`. `/etc/openclaw/agents.json` should be a symlink to `/srv/agents/index.json`.

## Why these stay separate

- **Identity & persona** drive each agent's decisions; sharing would erase their distinction (e.g., `manager` vs `developer`).
- **Tokens & OAuth state** are per-Atlassian-account / per-Google-account credentials.
- **Runtime state** files are written by services running as each agent; sharing would cause race conditions and lost events.
- **Sessions & memory** are by definition private to each agent's reasoning loop.
