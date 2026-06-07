# Agent ↔ PM Read API

Loopback-only HTTP endpoints that active OpenClaw agents use to **read**
the live state of tasks, epics, and projects on demand. This applies to
both coding agents and the monitor agent. It replaces the legacy practice
of PM inlining a large context packet into every PM-channel turn, which
could leave agents answering from only a fraction of the PM state.

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

?grant=<short-lived scoped context grant>
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
gate is based on client-IP headers:

- no `X-Forwarded-For` or `X-Real-IP` header -> accepted as direct
  loopback traffic;
- `X-Forwarded-For` or `X-Real-IP` present with any non-loopback address
  -> **403 Forbidden**.

In the standard deployment, PM listens on `127.0.0.1:<pm-port>`. The
public reverse proxy handles browser traffic, but those proxy-stamped
headers cause the agent endpoints to refuse. Agents call PM **directly**
at `http://127.0.0.1:<pm-port>`, not through the public site.

Implementation: [`lib/agents/context-api/auth.ts:isLoopbackRequest`](../lib/agents/context-api/auth.ts).

## Authentication

PM-channel turns should use prompt-safe context grant URLs. A grant is an
opaque `?grant=...` query token minted by PM for one addressed agent and
one scope (`task`, `epic`, or `project`). PM stores only the token hash,
binds it to the target agent and scope id, and enforces expiry plus a
bounded use count.

The per-turn system prompt includes ready-to-curl URLs with the grant
already attached. Agents should call those URLs directly and should not
need to read or repeat their long-lived PM-channel bearer token. Direct
project-scoped chats also receive a project context grant; when the user
pastes same-project Task or Epic links, PM additionally mints grants for
those linked items so the agent can fetch the authoritative item context
instead of trying to open the public browser URL.

Legacy bearer auth is still available only as a compatibility and
operator-smoke fallback while `PM_CONTEXT_GRANTS_REQUIRED=0`:

- Per-agent: `~/.openclaw/openclaw.json` at `channels.pm.token`.
- File map:
  `/etc/openclaw/pm-channel-tokens.json` (root-owned, `{ "<slug>": "<token>", "default": "<token>" }`).
- Env var: `PM_OPENCLAW_CHANNEL_TOKEN_<SLUG>` (uppercased, non-alphanum ->
  `_`) or the shared `PM_OPENCLAW_CHANNEL_TOKEN`.

When `PM_CONTEXT_GRANTS_REQUIRED=1`, context endpoints reject bearer-only
requests. Validation lives in
[`lib/agents/context-api/auth.ts`](../lib/agents/context-api/auth.ts) and
[`lib/agents/context-grants.ts`](../lib/agents/context-grants.ts).

Unauthorised request → **401 Unauthorized**.

## Role permissions

Active coding agents and the monitor agent can receive PM-channel turns,
fetch grant-scoped PM context, read attachment metadata/text exposed by
that context, and submit grant-scoped work-item proposals. The proposal
endpoint stores a pending change-set only; it does not mutate the board
until a human applies it.

Only active humans and active coding agents are assignable principals for
Task assignee, Task reviewer/acting manager, and Epic acting manager
fields. Monitor agents are intentionally excluded from those picker and
validator pools. They can observe, triage, wake/restart agents, submit
proposals when a human grants that capability, and operate monitor-owned
deployment/verifier flows, but they are not normal implementation owners.

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
    "assignee":  { "username": "coding-agent", "kind": "agent" },
    "reviewer":  { "username": "review-agent", "kind": "agent" },
    "reporter":  { "username": "requester",    "kind": "human" }
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
    { "id": "…", "createdAt": "…", "author": { "username": "coding-agent", "kind": "agent" }, "body": "…" }
  ],
  "discussion": [              // ordered oldest-first
    {
      "id": "…",
      "createdAt": "…",
      "sender":    { "username": "requester", "kind": "human" },
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
      "actor":       { "username": "review-agent", "kind": "agent" },
      "targetAgent": "review-agent",
      "payload":     { … parsed JSON … }
    }
  ],
  "attachments": [
    {
      "id": "…",
      "filename": "spec.pdf",
      "mimeType": "application/pdf",
      "sizeBytes": 12345,
      "uploader":   { "username": "requester", "kind": "human" },
      "createdAt":  "…",
      "downloadPath": "/api/attachments/<id>"  // call from loopback
    }
  ],
  "currentThread": [             // last 5 live discussion msgs, oldest-first — PRIMARY context
    {
      "id": "…",
      "createdAt": "…",
      "sender":    { "username": "review-agent", "kind": "agent" },
      "body":      "Want me to draft this as a small spec / proposal…",
      "targetType":"user",
      "targetLabel":"requester"
    }
  ],
  "recentComments": [            // last 3 comments, oldest-first — PRIMARY context
    { "id": "…", "createdAt": "…", "author": { … }, "body": "…" }
  ],
  "meta": {
    "fetchedAt":    "…",
    "note":         "Soft-deleted comments / discussion / archives are filtered server-side. Discussion is oldest-first; activity is newest-first.",
    "priorityNote": "currentThread + recentComments are the immediate conversational hot path. If you proposed a scope in the last few messages and the user agreed, MATCH THAT SCOPE EXACTLY — do not silently widen it."
  }
}
```

> **Priority context.** `currentThread` and `recentComments` denormalise the
> last few rows out of the full `discussion` / `comments` arrays. They are
> the immediate conversational hot path — read them BEFORE composing your
> reply. The same rows are also present in the full arrays; the denorm
> exists so callers don't have to scan a 2000-row history to find "what
> just happened". The dispatcher also inlines this slice into the
> per-turn system prompt under a `=== RECENT … DISCUSSION ===` heading,
> so an agent has it even if they decide not to fetch the JSON.

Status codes: **200 OK** on success, **401** for a missing/invalid grant
or disabled legacy bearer, **403** for non-loopback, **404** when the
task is missing or soft-deleted.

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

Every PM-channel turn delivered to an agent now embeds two things in the
system prompt:

1. A `=== RECENT … DISCUSSION ===` block with the last 5 non-deleted
   discussion messages (oldest-first), plus the SCOPE-ANCHORING RULE
   that warns against silently widening agreed scope. This is the
   primary context for the current turn — no fetch required.
2. A `LIVE PM CONTEXT — FETCH WHEN YOU NEED DEEPER HISTORY` block with
   ready-to-curl grant URLs for the relevant task / epic / project. Use
   these when the RECENT block doesn't cover what you need.

The expected pattern is:

```bash
# 1. Read the task — always, on every turn that lands on a task.
TASK=$(curl -s \
  'http://127.0.0.1:3000/api/agents/context/task/<taskId>?grant=<task-grant>')

# 2. If the task lives under an epic AND the conversation discusses the
#    epic, also pull the epic.
EPIC=$(curl -s \
  'http://127.0.0.1:3000/api/agents/context/epic/<epicId>?grant=<epic-grant>')

# 3. Before proposing work-item changes, pull project state to avoid
#    duplicating an existing epic or task.
PROJ=$(curl -s \
  'http://127.0.0.1:3000/api/agents/context/project/<projectId>?grant=<project-grant>')
```

Then parse the JSON and use it as your primary source of truth for the
current state.

## What changed for operators

- PM stops sending the legacy `contextText` field on `pm-channel/ingest`
  for **chat dispatches** (the `task-chat` and `epic-chat` kinds). The
  field is `null` now.
- The OpenClaw pm-channel plugin no longer needs to do anything special
  with the supplemental context — there isn't any. The system prompt
  carries scoped live-fetch grant URLs and the agent does the fetch
  themselves.
- `pm-comment` / workflow-notification dispatches are unchanged in this
  pass; they still send a small inlined context body.
- Context endpoints now prefer short-lived grant URLs. The old
  PM-channel bearer still works only while `PM_CONTEXT_GRANTS_REQUIRED=0`
  so existing boxes can be rolled forward without a flag day.
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
3. No additional agent secret is needed for live context reads. PM mints
   grant URLs per channel turn and puts them in the prompt.
4. **No nginx changes needed.** These endpoints are deliberately
   loopback-only and should never be exposed via the public vhost.
5. Once `pm.service` is up, smoke the grant path by sending a Task or
   Epic Discussion turn and checking that the prompt contains `?grant=`
   URLs that return JSON from loopback. While `PM_CONTEXT_GRANTS_REQUIRED=0`,
   operators can also run a legacy bearer smoke from any agent's home:
   ```bash
   sudo -n -u coding-agent curl -s \
     -H "Authorization: Bearer $(jq -r .channels.pm.token /home/coding-agent/.openclaw/openclaw.json)" \
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
| Recent-exchange helpers       | [`lib/agents/context-api/recent.ts`](../lib/agents/context-api/recent.ts) |
| Dispatcher (thin envelope)    | [`lib/agents/chat-actions.ts`](../lib/agents/chat-actions.ts) |
