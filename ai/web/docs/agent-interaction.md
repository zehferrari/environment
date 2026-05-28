# Agent Interaction Guide

This guide is the agent-facing contract for interacting with the PM
system at `agents.vixi.au`. It covers what agents can do today, what
they must not assume, and where future project/epic/task actions should
land.

## Current Contract

Direct PM chat, task chat, task-comment, and epic chat agent replies use
the native OpenClaw `pm` channel. PM posts the user turn to the target
agent's local OpenClaw gateway:

```text
POST http://127.0.0.1:<gateway_port>/pm-channel/ingest
Authorization: Bearer <pm channel token>
Body: {
  "version": 1,
  "kind": "direct" | "task-chat" | "task-comment" | "epic-chat",
  "agentSlug": "<agent slug>",
  "sessionKey": "pm:...",
  "text": "<latest user message>",
  "contextText": "<PM context packet>",
  "systemPrompt": "<channel guidance>",
  "replyTarget": { "...": "origin channel metadata" },
  "callbackUrl": "http://127.0.0.1:3000/api/openclaw/pm-channel/reply",
  "streamUrl": "http://127.0.0.1:3000/api/openclaw/pm-channel/stream"
}
```

The gateway route is loopback-only. PM resolves the token from
`PM_OPENCLAW_CHANNEL_TOKEN_<AGENT>`, then
`/etc/openclaw/pm-channel-tokens.json`, then the shared
`PM_OPENCLAW_CHANNEL_TOKEN`. The OpenClaw channel plugin verifies that
token, runs the standard channel turn kernel, records the turn against
`sessionKey`, streams partial reply chunks back to PM for live display,
and posts final visible replies back to PM.

`/hooks/wake` remains useful for generic automation and legacy PM
events, but chat, task-comment, and epic-chat replies should not use
`/hooks/wake` or prompt-visible callback contracts.

PM stores every native-channel turn in `PmChannelRun` as soon as it is
queued locally. The run moves through `accepted`, `streaming`,
`complete`, or `failed` from the gateway response and stream/reply
callbacks, so reconnecting browsers can resume from durable state rather
than polling for a reply. A terminal stream `done` is not success by
itself: PM only marks a run `complete` after a durable final reply, a
valid workflow action, or a silent no-contribution reply is delivered.
If a channel turn ends without one of those outcomes, PM marks the run
`failed` and the browser keeps a visible failure bubble instead of
waiting indefinitely.

## Task, Epic, And Comment Chat

PM creates an `AgentSessionBinding` for every direct/task/epic
conversation. Direct chats use that stable `pm:` key for continuity.
Task, Epic, and task-comment turns derive a per-message key from the
binding so each PM request starts with a clean OpenClaw transcript while
still carrying the complete DB-backed PM context packet. OpenClaw owns
inbound recording, model dispatch, and final reply delivery from there;
those are channel behavior, not instructions shown to the model.

Task chat/comment payloads still include a PM context packet in
`contextText`, delivered to OpenClaw as supplemental context rather than
duplicated into the visible wake text. PM is the source of truth for
task, Epic, comments, activity, and attachment extracts; OpenClaw is the
owner of the channel session and communication lifecycle.

Task comments addressed to an agent, assigned to an agent, or mentioning
an agent use the same native channel directly. They do not enqueue a
legacy `task.commented` / `task.mentioned` wake through `pm-consumer`.

Replies must stay in the origin channel:

- User wrote in task chat -> agent reply is stored in task chat only.
- User wrote in epic chat -> agent reply is stored in epic chat only.
- User wrote a task comment -> agent reply is stored as a task comment
  only.

Agents should not post the same answer in both comments and chat.
They should also avoid no-op chatter: if a turn requires no visible
contribution, the final reply body must be exactly
`PM_SILENT_NO_CONTRIBUTION`. PM records the turn as complete without
creating a chat or comment row.

### Soft-deleted content is hidden from agents

A human can delete a comment, a Task/Epic Discussion bubble, or a
direct-agent-chat bubble. PM does **not** hard-delete the row — it
sets `deletedAt` + `deletedById` and keeps the body for human-side
review (the UI shows a collapsed dotted divider with a `[+]` toggle).
Every agent-context query (`buildTaskAgentContextPacket`,
`buildEpicAgentContextPacket`, the archived-discussion chain queries)
filters `deletedAt: null` so agents never see deleted bodies in any
TIMELINE MANIFEST or RELATED TIMELINE row. Agents should treat the
absence of a previously-seen row as final — do not infer, search for,
or retry against it.

Hard purge of soft-deleted rows happens through the existing
project-bin-empty path.

### Directed-message rule

A task comment, task-chat message, or epic-chat message is either a
**broadcast** (no specific addressee — typical of an open question to
the assignee/reviewer/role-holders) or **directed** at one or more
specific agents. PM resolves the directed set from:

- discussion `targetType`/`targetValue` (`agent:<slug>`, a `multi`
  array, `all-coders`, or a `user:<id>`),
- explicit `@<username>` mentions in the comment body (only mentions
  that resolve to an active agent count).

PM dispatches a PM-channel turn to every role-holder as today — so a
manager/assignee can still read the content and update their session
memory — but every native PM-channel turn carries a `DIRECTED-MESSAGE
RULE` block that names the directed set. If the recipient is NOT in
that set and the message is not a broadcast, the recipient MUST reply
exactly `PM_SILENT_NO_CONTRIBUTION` regardless of whether they are the
assignee, reviewer, epic acting manager, or reporter. Workflow turns
(`start`, `ready_for_review`, `review_*`, `triage_to_todo`) are
exempt — those are role-directed by construction and always expect a
visible reply from the addressed assignee/reviewer.

## Channel Reply Contract

The OpenClaw `pm` channel may post live partial chunks to PM while a turn
is running:

```json
{
  "version": 1,
  "channel": "pm",
  "target": {
    "kind": "direct | task-chat | task-comment | epic-chat",
    "agentSlug": "<agent slug>",
    "messageId": "<origin PM message id>"
  },
  "event": "partial",
  "delta": "<new visible text chunk>"
}
```

The stream route is `POST /api/openclaw/pm-channel/stream` with the same
Bearer token. PM treats stream chunks as ephemeral UI state; the final
durable answer still comes through the reply route.

The stream endpoint also accepts terminal `done` and `error` events.
`done` is only a stream lifecycle marker. It must follow an already
delivered final reply; otherwise PM treats the turn as failed because no
chat/comment record exists to preserve for later page loads.

The OpenClaw `pm` channel posts final visible replies to PM:

```json
{
  "version": 1,
  "channel": "pm",
  "target": {
    "kind": "direct | task-chat | task-comment | epic-chat",
    "agentSlug": "<agent slug>",
    "messageId": "<origin PM message id>"
  },
  "text": "<agent reply text>"
}
```

The route is `POST /api/openclaw/pm-channel/reply` with
`Authorization: Bearer <PM_OPENCLAW_CHANNEL_TOKEN>`. PM validates the
target and active agent user before writing the reply to direct chat,
task chat, epic chat, or task comments.

If the final reply text is exactly `PM_SILENT_NO_CONTRIBUTION`, PM does
not write a visible reply. It records a `*.silent` ActivityLog row with
`inReplyToMessageId` so pending live bubbles settle cleanly.

Task and Epic Discussion replies must use two markdown sections:

```markdown
## Section A - Full Response
<complete final formatted answer>

## Section B - Short Summary
<short direct summary focused on the human's latest request>
```

The browser shows Section B by default in saved Discussion bubbles and
lets the user flip to Section A. Live streaming and pending reply blocks
show Section A. PM normalizes non-conforming Discussion replies at the
callback boundary so the UI always has both display modes.

## Context Requirements

Agents should answer from the whole provided context, not only the last
line. The PM prompt can include:

- task title, description, status, project, assignee, reviewer, and
  parent/subtask context;
- Epic title, status, description, assignee, and acting-manager context;
- **every** comment on the item (up to a generous breadth cap, currently
  40), regardless of who wrote it or whether the agent was directly
  addressed by it;
- **every** live Task/Epic Discussion message on the item (up to a
  generous breadth cap, currently 50), plus the archived-discussion
  chain that produced the current room, regardless of which agent each
  message was directed at and including other agents' replies and
  routing labels such as `All Coders` or a specific target;
- related task activity;
- task and Epic attachment metadata;
- cached text excerpts for supported text-like attachments.

Every rendered packet starts with a `TIMELINE MANIFEST` listing every
fetched comment/chat/activity row by id+actor+createdAt before the
bodies. Per-body clips report the omitted character count inline
(`[truncated: N more chars]`), and a packet annotates `[partial
context: …]` when a row cap is hit so the agent can tell when older
rows may exist beyond the packet.

PM owns this context packet. OpenClaw private memory may help the agent
reason, but PM task/Epic/comment/activity/attachment data is the source
of truth for the reply.

If an attachment is important but its content is not present, the agent
should say which attachment needs inspection instead of inventing
details. Binary, unsupported, failed, or too-large attachments are
identified by filename and `/api/attachments/<id>` path.

## Work-Item Proposals (propose → approve)

Implemented for direct PM chats attached to a project and for Task/Epic
Discussion messages. Every human-authored project-scoped message carries
the project environment (repo path, git identity, picker defaults,
existing epics + open tasks) plus a single-use proposal grant. In
Task/Epic Discussion, the grant is consumed per addressed agent so an
`All Coders` message can let each coder submit one proposal. The agent
must use that grant only when the current human message directly asks for
project work-item changes. The agent does NOT mutate the board — it
submits a typed change-set:

```text
POST http://127.0.0.1:3000/api/agent/projects/<projectId>/proposals
Content-Type: application/json
{
  "grantMessageId": "<DirectAgentChatMessage or AgentChatMessage id supplied in the turn>",
  "token": "<one-shot HMAC grant token supplied in the turn>",
  "planId": "<unique id for this proposal; re-POST is idempotent>",
  "summary": "<one-line summary>",
  "operations": [ /* typed ops, applied in order, all-or-nothing */ ]
}
```

Operations: `create_epic`, `create_task`, `create_subtask`,
`update_epic`, `update_task`, `comment_task`. New items take a `ref`
that must start with `tmp:` and that later ops reference (epic / parent);
existing items are addressed by their real id from the project-environment
block. `assignee` / `actingManager` are usernames (or `null` to unset).

PM validates the grant (single-use, bound to project + agent + message),
then dry-run-validates every op under human-triggered grant semantics:
active principals, project scoping, hierarchy, known statuses, and valid
task-status transitions are checked; new tasks land in Backlog, new
epics open. The **requesting human** (the `senderUserId` of the grant
message — direct-chat or Task/Epic Discussion) is recorded as the
`reporterId` of every newly-created epic and task in the change-set, so
the board attributes the request back to the human who asked the agent
to plan it. If the grant message has been deleted by the time the human
applies the proposal, PM falls back to the agent as reporter. The proposal
endpoint is token-scoped and intentionally does not require a browser
session; middleware lets the request reach the route handler, where the
HMAC grant and active agent are verified. A valid change-set is stored
as a pending `WorkItemProposal`; nothing on the board changes yet. A
human reviews it in the chat and clicks Apply (the whole set commits in
one transaction) or Reject. Applied mutations are attributed to the
agent in `ActivityLog`, while the human's approval is recorded by
`WorkItemProposal.appliedById` + a `workitem.proposal.apply` row.
Re-validation runs again at apply time, so a stale proposal aborts
without writing.

## Description Writes (drafts, not direct writes)

Human-authored task and epic chat messages carry a one-shot
description-DRAFT capability by default. PM sends the agent a
token-scoped endpoint only in the native-channel system prompt:

```text
POST http://127.0.0.1:3000/api/tasks/<taskId>/description
POST http://127.0.0.1:3000/api/epics/<epicId>/description
Content-Type: application/json
{
  "messageId": "<AgentChatMessage id supplied in the turn>",
  "token": "<one-shot HMAC description token supplied in the turn>",
  "description": "<complete final markdown description>"
}
```

The endpoint validates the message grant, target id, token, active
agent, and single-use stamp, then stores the proposed description as a
**draft** in the `DescriptionDraft` table tagged with the human
`requesterUserId` taken from the grant message's `senderUserId`. The
agent's POST does NOT replace the task/epic description directly.

The draft is requester-bound and ephemeral:

- it is visible only to the human who clicked "Ask AI to update
  description" — never to other viewers of the same task/epic;
- the open task/epic page heartbeats every 15s
  (`POST /api/system/description-draft/heartbeat`) bumping
  `lastSeenAt`; if the user closes the page (or the tab is hidden
  long enough), heartbeats stop and the reaper purges the row inside
  ~60s — so an agent's POST that arrives after the requester left
  never leaks into a later session;
- a 30-minute `expiresAt` is the backstop in case heartbeats fail
  silently;
- the human applies the draft with the task/epic form's normal "Save
  changes" button (which writes the description into `Task` /
  `Epic`), or discards it via the rollback icon — both clear the
  draft row.

The agent must call this endpoint only when the current human message
directly asks to update, rewrite, reformat, or replace the description.
For room-scoped chat rows, each addressed agent receives its own
token; any active addressed agent can use only its own token.

## PM Workflow Actions

Mission Control now grants role-aware task workflow actions through the
same native PM-channel turns used for task comments. Workflow turns carry
the full task context packet, the exact required action, and a scoped
token for:

```text
POST /api/agent/tasks/<taskId>/workflow
```

Allowed actions are `start`, `ready_for_review`, `review_feedback`,
`review_done`, and `triage_to_todo` (`submit_review` is accepted as a
legacy alias for `ready_for_review`). PM validates the addressed agent,
task assignee/reviewer role, task status, and parent Epic status before
writing. Agent replies to workflow turns are stored as normal task
comments only when they add useful task information; no-contribution
turns use the silent reply token.

Backlog assignment is planning/opinion only: the assigned agent replies
with a task-comment implementation plan and does not change status.
`To Do` is the approval-to-execute signal: the assigned agent moves the
task to `In Progress` and starts immediately. `Review` is only for
completed implementation review.

### Commit hygiene + Review verification

For code-touching tasks (task has a `branchName` set on a project with
a `repositoryPath`), workflow turns inject a **Commit hygiene** block
that names the resolved COMMIT_PREFIX (task.commitPrefix →
epic.commitPrefix fallback), the branch, and the repository path. The
assignee must:

- prefix every commit on the branch with the resolved COMMIT_PREFIX
  (e.g. `HOMELAB-41: short imperative summary`),
- commit ALL local changes and push to `origin/<branchName>` BEFORE
  calling `action: ready_for_review`,
- include `repoTouched: true` in the workflow POST when calling
  `ready_for_review` (default when branchName + repositoryPath are
  set), or `repoTouched: false` for docs-only / decision-only tasks.

When `repoTouched` resolves true, PM drops a JSON job into
`/var/lib/pm/branch-verify/<jobId>.json`. The karen-side runner
(`pm-verify-runner.service`) runs `git -C <repositoryPath> fetch
origin <branchName>` on the already-cloned repo, looks for commits
whose subject starts with the COMMIT_PREFIX on
`origin/<branchName>`, and posts a `pm.repo.verify.ok` task comment
(with HEAD sha, the latest prefix-matching commit, push timestamp) or
`pm.repo.verify.fail` (no push found / no prefix match). The Review
transition itself is NOT blocked — the verifier publishes its result
asynchronously and the reviewer reads it before approving.

The reviewer's `review_requested` workflow turn adds a **Review
verification** block instructing them to read the latest
`pm.repo.verify.*` comment first: on `ok` proceed; on `fail` send
`review_feedback` asking the assignee to push (with prefix) before
review; if neither has appeared, wait briefly for Karen.

## Future Agent Actions

Further agent write actions should follow the same shape (typed endpoint,
scoped token, server-side validation, `ActivityLog`). Do not let agents
mutate the database directly.

Still future:

- create projects;
- upload or attach files from an agent turn;
- direct database mutations or unscoped workflow changes.

Each such action should follow the same shape:

- PM provides a typed endpoint and required body shape.
- The agent authenticates with a token scoped to the intended action.
- PM validates permissions and workflow rules server-side.
- PM writes `ActivityLog` rows with `targetAgent` when an agent acts.
- UI surfaces success, failure, and pending state without requiring a
  manual reload.

## Non-Goals

Agents should not:

- write directly to the Prisma SQLite database;
- infer hidden endpoints;
- reuse callback tokens outside the message/action they were issued for;
- post duplicate replies across channels;
- bypass PM workflow rules by using host filesystem access.
