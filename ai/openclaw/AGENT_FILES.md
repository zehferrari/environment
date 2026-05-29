# Per-agent unique files

These files stay separate for each registered agent. Private identity, memory, and runtime config files live under the host agent-files root; credentials, runtime state, sessions, logs, and task notes live under each agent's home. The shared repo deliberately does not version-control them.

## Identity & persona — `<agentFilesRoot>/<user>/*.md`

`AGENTS.md`, `ROLES.md`, `TEAM_WORKFLOW.md`, and `CODE_REPOS.md` are **shared by every agent** and live in this repo. The remaining files (`SOUL`, `IDENTITY`, `USER`, `TOOLS`, `MEMORY`, `HEARTBEAT`, `openclaw.json`) are **per-agent in content** but **single-canonical in location**: each lives once under the host's private agent-files root, defaulting to `/srv/agents/openclaw/<user>/<file>` and overrideable with top-level `agentFilesRoot` in `/etc/openclaw/agents.json`. Workspace/config copies are symlinks back to that canonical file, so no matter which runtime path is read, it sees the same file.

| File | Source of truth | Purpose |
|---|---|---|
| `AGENTS.md` | host checkout (x1: `/srv/Code/environment/ai/openclaw/AGENTS.md`; yoga510: `/home/rachael/Code/environment/ai/openclaw/AGENTS.md`) | **Shared baseline for every agent.** Both `~/workspace/AGENTS.md` and `~/.openclaw/workspace/AGENTS.md` symlink to the repo file. |
| `ROLES.md` | host checkout (x1: `/srv/Code/environment/ai/openclaw/ROLES.md`; yoga510: `/home/rachael/Code/environment/ai/openclaw/ROLES.md`) | Role-specific behaviour (`## Manager`, `## Developer`, `## Monitor`). Agent identifies its role from `agents.json` and reads the matching section. Same symlink pattern as `AGENTS.md`. |
| `TEAM_WORKFLOW.md` | host checkout (x1: `/srv/Code/environment/ai/openclaw/TEAM_WORKFLOW.md`; yoga510: `/home/rachael/Code/environment/ai/openclaw/TEAM_WORKFLOW.md`) | Action-indexed workflow playbook. Same symlink pattern. |
| `CODE_REPOS.md` | host checkout (x1: `/srv/Code/environment/ai/openclaw/CODE_REPOS.md`; yoga510: `/home/rachael/Code/environment/ai/openclaw/CODE_REPOS.md`) | Shared-code workflow for `/srv/Code`, `claim-branch`, git identity, and the human-only PR boundary. Same symlink pattern. |
| `SOUL.md` | `<agentFilesRoot>/<user>/SOUL.md` (per-agent, not in this repo) | Personality, tone, decision-making heuristics. Free-form, agent-specific. |
| `IDENTITY.md` | `<agentFilesRoot>/<user>/IDENTITY.md` (per-agent) | Core "who am I" preamble loaded on every session start. |
| `USER.md` | `<agentFilesRoot>/<user>/USER.md` (per-agent) | What the agent knows about zeh from the agent's own perspective. |
| `TOOLS.md` | `<agentFilesRoot>/<user>/TOOLS.md` (per-agent) | Notes on the agent's own tool usage habits. |
| `MEMORY.md` | `<agentFilesRoot>/<user>/MEMORY.md` (per-agent) | Long-running per-agent memory (project history, recurring topics, pending follow-ups). |
| `HEARTBEAT.md` | `<agentFilesRoot>/<user>/HEARTBEAT.md` (per-agent) | Liveness marker / last-tick state. |
| `openclaw.json` | `<agentFilesRoot>/<user>/openclaw.json` (per-agent, mode `0660` when `codeGroup` exists, otherwise `0600`) | OpenClaw runtime config for model providers, defaults, and limits. `~/.openclaw/openclaw.json` symlinks here. The agent owns the file; the configured `codeGroup` can edit it for PM/dashboard workflows. |

`install.sh` creates the agent-files root, mirrors the host `codeRoot` permissions onto the parent shared agent directory, creates one subdirectory per registered agent, migrates any existing regular private files from the agent's workspace/config paths, and leaves symlinks behind. Coding agents usually have both `~/workspace/` and `~/.openclaw/workspace/`; monitoring-only agents may have only `~/.openclaw/workspace/`.

## Authentication & secrets — `~/.ssh/`, `~/.config/`

**Never** commit any of these to git.

| Path | Purpose |
|---|---|
| `~/.ssh/jiraToken.txt` | Atlassian API token used by `skills/jira/lib.js` for Jira REST calls. |
| `~/.ssh/bitbucketToken.txt` | Bitbucket API/app token for `git push` (HTTPS) or repo API calls. |
| `~/.ssh/id_*` | Per-agent SSH key pair (Bitbucket, optional GitHub). |
| `~/.config/openclaw/openclaw-secrets.env` | Telegram bot token, OpenClaw gateway token, model-provider API keys (Moonshot, Z.ai). |
| `~/.config/openclaw/openclaw-webhook.env` | Webhook signing secrets (Jira, Bitbucket). |
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

Per-agent clones of project repos (e.g., `~/Code/whitsunday-discovery-trail`). Each agent has its own working copy with its own branch state. NOT shared.

## Webhook routing — `/home/karen/webhooks/users.json`

Lives under `karen`'s home (not under either coding agent). Maps Jira display names and accountIds to agent users for webhook routing. Not part of this repo because it lives in the webhook receiver's runtime path.

## Why these stay separate

- **Identity & persona** drive each agent's decisions; sharing would erase their distinction (e.g., `manager` vs `developer`).
- **Tokens & OAuth state** are per-Atlassian-account / per-Google-account credentials.
- **Runtime state** files are written by services running as each agent; sharing would cause race conditions and lost events.
- **Sessions & memory** are by definition private to each agent's reasoning loop.
