# Agent ↔ PM Read API

Loopback-only HTTP endpoints OpenClaw agents (asdrubal, barekbaal, karen, and
any future agents on a replicated box) use to **read** the live state of
tasks, epics, and projects on demand. Replaces the legacy practice of PM
inlining a ~58 KB context packet into every PM-channel turn — that pattern
hit OpenClaw's pm-channel plugin in a way that silently dropped most of the
content, leaving agents to answer from a fraction of what PM had built.

This page is the contract between **PM** and **agents** on this host. It is
required reading for anyone bringing up a new box: the agents will follow
these endpoints because the per-turn system prompt names them explicitly,
and operators are expected to keep the endpoints working as described
here.

## At a glance

```
GET /api/agents/context/task/<taskId>
GET /api/agents/context/epic/<epicId>
GET /api/agents/context/project/<projectId>

Authorization: Bearer <agent's pm-channel token>
Host:          must be 127.0.0.1, localhost, or [::1]
```

All three return JSON. All three are **loopback-only**. All three filter
soft-deleted rows server-side, so deleted content stays invisible.

## Why this exists

- PM is the source of truth for task / epic / discussion data.
- OpenClaw is the right place to own each agent's **working memory** —
  session continuity, summarisation, per-turn prompt assembly.
- Putting both in the per-turn prompt was forcing PM to compete with
  OpenClaw on the prompt budget, and the OpenClaw pm-channel plugin's
  supplemental-context handoff was lossy in practice.
- A read API is the standard split: PM stays canonical for the data; the
  agent fetches it when relevant, drawing on OpenClaw memory between turns.

## Loopback constraint

The endpoints reject any request that arrived via a reverse proxy. The
gate is:

- `X-Forwarded-For`, `X-Forwarded-Host`, or `X-Forwarded-Proto` headers
  present → **403 Forbidden** (nginx is in the path).
- `Host` header doesn't match `127.0.0.1[:port]`, `localhost[:port]`, or
  `[::1][:port]` → **403 Forbidden**.

On x1, PM listens on `127.0.0.1:3000`. nginx terminates TLS for
`agents.vixi.au` and proxies to that loopback bind for browser traffic —
but those nginx-stamped headers cause the agent endpoints to refuse. The
agents call PM **directly** at `http://127.0.0.1:3000`, not through nginx.

Implementation: [`lib/agents/context-api/auth.ts:isLoopbackRequest`](../lib/agents/context-api/auth.ts).

## Authentication

The Authorization header carries an agent's PM-channel bearer — the same
secret OpenClaw uses to call PM back on `/api/openclaw/pm-channel/reply`.
**Agents do not need a new token.** The value lives in:

- Per-agent: `~/.openclaw/openclaw.json` at `channels.pm.token`. This is
  the field every gateway reads on startup; reusing it is intentional.
- File map (the same source the agent reads from):
  `/etc/openclaw/pm-channel-tokens.json` (root-owned, `{ "<slug>": "<token>", "default": "<token>" }`).
- Env var: `PM_OPENCLAW_CHANNEL_TOKEN_<SLUG>` (uppercased, non-alphanum →
  `_`) or the shared `PM_OPENCLAW_CHANNEL_TOKEN`.

PM looks up the right per-agent token from any of those sources; a
caller may also present the shared token and authenticate as "an active
agent". Validation: [`lib/agents/context-api/auth.ts:authenticateAgentBearer`](../lib/agents/context-api/auth.ts).

Unauthorised request → **401 Unauthorized**.

## The endpoints

### `GET /api/agents/context/task/<taskId>`

Returns the live JSON for a task: descriptions, the assignee / reviewer /
reporter triple, the full subtask list, every comment (oldest-first),
every discussion message live + the chained archived rooms (oldest-first),
the activity log (newest-first, last 500 events), and attachment metadata.

**Use it:** when a turn lands on a task and you need any historical detail
that isn't already in OpenClaw session memory. Call it FIRST, before
composing your reply — the data is authoritative and cheap.

Shape:

```jsonc
{
  "task": {
    "id": "cmpnyt…",
    "title": "Chat/Discussions Context packet truncate",
    "status": "Done",
    "description": "## Problem\n…",
    "branchName": "feature/HOMELAB-41-…",
    "commitPrefix": "HOMELAB-41:",
    "createdAt": "2026-05-27T11:12:46.974Z",
    "updatedAt": "2026-05-28T00:34:44.180Z",
    "assignee":  { "username": "asdrubal",  "kind": "agent" },
    "reviewer":  { "username": "barekbaal", "kind": "agent" },
    "reporter":  { "username": "zeh",       "kind": "human" }
  },
  "project": {
    "id": "cmpmnv…",
    "slug": "environment",
    "name": "Environment",
    "description": null,
    "readmePath": null,
    "repositoryPath": "/srv/Code/environment.worktrees/…"
  },
  "epic": null,                // or { id, title, status, description, branchName, commitPrefix, assignee, actingManager }
  "parentTask": null,          // or { id, title, status }
  "subtasks": [
    { "id": "…", "title": "…", "status": "To Do", "assignee": { … } }
  ],
  "comments": [
    { "id": "…", "createdAt": "…", "author": { "username": "asdrubal", "kind": "agent" }, "body": "…" }
  ],
  "discussion": [              // ordered oldest-first
    {
      "id": "…",
      "createdAt": "…",
      "sender":    { "username": "zeh", "kind": "human" },
      "body":      "…",
      "targetType":"agent",
      "targetLabel":"Barekbaal Irwin",
      "archived":  false,      // true when sourced from an archived room
      "archiveId": null        // present when archived
    }
  ],
  "activity": [                // ordered newest-first, last 500
    {
      "id": "…",
      "createdAt": "…",
      "kind": "task.chat.reply",
      "actor":       { "username": "barekbaal", "kind": "agent" },
      "targetAgent": "barekbaal",
      "payload":     { … parsed JSON … }
    }
  ],
  "attachments": [
    {
      "id": "…",
      "filename": "spec.pdf",
      "mimeType": "application/pdf",
      "sizeBytes": 12345,
      "uploader":   { "username": "zeh", "kind": "human" },
      "createdAt":  "…",
      "downloadPath": "/api/attachments/<id>"  // call from loopback
    }
  ],
  "meta": {
    "fetchedAt": "…",
    "note":      "Soft-deleted comments / discussion / archives are filtered server-side. Discussion is oldest-first; activity is newest-first."
  }
}
```

Status codes: **200 OK** on success, **401** for bad bearer, **403** for
non-loopback, **404** when the task is missing or soft-deleted.

### `GET /api/agents/context/epic/<epicId>`

Same shape minus `parentTask`, plus `epic.actingManager`, plus a `tasks`
array of every live task under the epic. Use when the agent's turn is on
an epic discussion, or when you need to enumerate the epic's tasks
without per-task detail.

### `GET /api/agents/context/project/<projectId>`

Returns the project envelope used when proposing work-item change-sets:
project metadata, the default git identity, the full active-principals
list (valid `assignee` / `actingManager` values), every non-archived
epic with their descriptions, and every OPEN task (status ≠ Done).
Per-task / per-epic detail isn't included here — fetch the relevant
task / epic endpoint instead.

```jsonc
{
  "project":            { "id", "slug", "name", "description", "readmePath", "repositoryPath" },
  "defaultGitIdentity": { "name", "email" },
  "principals": [ { "id", "username", "kind" }, … ],
  "epics":      [ { "id", "title", "status", "description", "branchName", "commitPrefix", "assignee", "actingManager" }, … ],
  "openTasks":  [ { "id", "title", "status", "epicId", "parentTaskId", "assignee", "actingManager", "branchName", "commitPrefix" }, … ],
  "meta":       { "fetchedAt", "note" }
}
```

## How to call it from an agent

Every PM-channel turn delivered to an agent now embeds a `LIVE PM CONTEXT
— FETCH BEFORE YOU REPLY` block in the system prompt. The block contains
ready-to-curl commands with the bearer + URL pre-filled for the IDs
relevant to this turn. The expected pattern is:

```bash
# 1. Read the task — always, on every turn that lands on a task.
TASK=$(curl -s -H "Authorization: Bearer <bearer>" \
  'http://127.0.0.1:3000/api/agents/context/task/<taskId>')

# 2. If the task lives under an epic AND the conversation discusses the
#    epic, also pull the epic.
EPIC=$(curl -s -H "Authorization: Bearer <bearer>" \
  'http://127.0.0.1:3000/api/agents/context/epic/<epicId>')

# 3. Before proposing work-item changes, pull project state to avoid
#    duplicating an existing epic or task.
PROJ=$(curl -s -H "Authorization: Bearer <bearer>" \
  'http://127.0.0.1:3000/api/agents/context/project/<projectId>')
```

Then parse the JSON and use it as your primary source of truth for the
current state.

## What changed for operators

- PM stops sending the legacy `contextText` field on `pm-channel/ingest`
  for **chat dispatches** (the `task-chat` and `epic-chat` kinds). The
  field is `null` now.
- The OpenClaw pm-channel plugin no longer needs to do anything special
  with the supplemental context — there isn't any. The system prompt
  carries the live-fetch URLs and the agent does the fetch themselves.
- `pm-comment` / workflow-notification dispatches are unchanged in this
  pass; they still send a small inlined context body.
- New routes are added to the middleware allowlist
  ([`middleware.ts:isTokenScopedAgentContextRead`](../middleware.ts)) so
  session cookies aren't required.

## What happens on a replicated box

When this repo lands on a new host:

1. `pnpm build` of `ai/web` includes the three new routes automatically.
2. `ai/web/deploy/pm.env.example` already exposes `PM_INTERNAL_APP_URL`
   and `PM_AGENT_CALLBACK_URL`. Set both to `http://127.0.0.1:<pm-port>`
   on the replicated host. The system prompts the agents receive use
   `PM_AGENT_CALLBACK_URL` first.
3. Each agent's `~/.openclaw/openclaw.json` already has
   `channels.pm.token` — that **is** the bearer for these endpoints; no
   additional secret to provision.
4. **No nginx changes needed.** These endpoints are deliberately
   loopback-only and should never be exposed via the public vhost.
5. Once `pm.service` is up, smoke the endpoints from any agent's home:
   ```bash
   sudo -n -u barekbaal curl -s \
     -H "Authorization: Bearer $(jq -r .channels.pm.token /home/barekbaal/.openclaw/openclaw.json)" \
     'http://127.0.0.1:3000/api/agents/context/project/<some-project-id>' | jq .meta
   ```
   A 200 with a populated body means the chain is healthy end-to-end.

## Soft-delete contract

A comment, discussion bubble, or chat message with `deletedAt` set is
**not** returned. Agents see whatever a human reviewer has not deleted.
Restored rows (`deletedAt: null` again after a human clicked ↺ on the
PM web UI) become visible immediately on the next fetch. This matches
the contract documented in `agent-interaction.md` §Soft-deleted content.

## Limits

Per-call caps in the JSON serializer
([`lib/agents/context-api/serialize.ts`](../lib/agents/context-api/serialize.ts)):

| Field      | Limit                         |
|------------|-------------------------------|
| comments   | 2 000 newest, oldest-first    |
| discussion (live)    | 2 000 newest         |
| discussion (archive) | up to 8 archive rooms |
| activity   | 500 newest, newest-first      |
| attachments| 200 newest                    |

These caps are deliberately well above realistic task sizes. If a task
ever bumps them, page back through history is a future Phase 2 work —
**not implemented yet.** For now: a busy task that exceeds the cap
returns the most recent N rows and the agent treats anything older as
absent.

## Future Phase 2 (not yet done)

- **OpenClaw `vixi-pm` plugin** that registers these endpoints as native
  tools so the model can call `pm_read_task(id)` instead of constructing
  a curl. Today's curl-from-prompt approach works for Claude / Codex CLI
  backends but isn't elegant.
- **Pagination / ?since= incremental fetch**, so an agent that just read
  a task 30 s ago can fetch only the delta.
- **Workflow-notification dispatcher** switched to the same thin-envelope
  pattern. Today it still inlines context for the workflow turns; that's
  a follow-up.
- **Per-agent context tools mapped to `pm_*`**: `pm_propose_work_items`,
  `pm_submit_workflow`, `pm_post_comment`. Once OpenClaw exposes them
  as tools the agent doesn't need to remember curl URLs at all.

## Files

| Concern                       | File                                                     |
|-------------------------------|----------------------------------------------------------|
| Auth + loopback gate          | [`lib/agents/context-api/auth.ts`](../lib/agents/context-api/auth.ts)        |
| JSON serializers              | [`lib/agents/context-api/serialize.ts`](../lib/agents/context-api/serialize.ts) |
| Route — task                  | [`app/api/agents/context/task/[id]/route.ts`](../app/api/agents/context/task/[id]/route.ts) |
| Route — epic                  | [`app/api/agents/context/epic/[id]/route.ts`](../app/api/agents/context/epic/[id]/route.ts) |
| Route — project               | [`app/api/agents/context/project/[id]/route.ts`](../app/api/agents/context/project/[id]/route.ts) |
| Middleware allowlist          | [`middleware.ts`](../middleware.ts)                       |
| Per-turn system prompt block  | [`lib/agents/context/task.ts:buildTaskNativeChannelPrompt`](../lib/agents/context/task.ts) and [`lib/agents/context/epic.ts:buildEpicNativeChannelPrompt`](../lib/agents/context/epic.ts) |
| Dispatcher (thin envelope)    | [`lib/agents/chat-actions.ts`](../lib/agents/chat-actions.ts) |
