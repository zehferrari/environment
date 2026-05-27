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
itself: PM only marks a run `complete` after a durable final reply is
posted to `/api/openclaw/pm-channel/reply`. If a channel turn ends
without that reply, PM marks the run `failed` and the browser keeps a
visible failure bubble instead of waiting indefinitely.

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
- recent task comments;
- full active Task/Epic Discussion history for the item once the agent
  is invited or mentioned, including other agents' replies and routing
  labels such as `All Coders` or a specific target;
- related task activity;
- task and Epic attachment metadata;
- cached text excerpts for supported text-like attachments.

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
epics open. The proposal
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

## Description Writes

Human-authored task and epic chat messages carry a one-shot description
write capability by default. PM sends the agent a token-scoped endpoint
only in the native-channel system prompt:

```text
POST http://127.0.0.1:3000/api/tasks/<taskId>/description
POST http://127.0.0.1:3000/api/epics/<epicId>/description
Content-Type: application/json
{
  "messageId": "<AgentChatMessage id supplied in the turn>",
  "token": "<one-shot HMAC description token supplied in the turn>",
  "description": "<complete replacement markdown description>"
}
```

The agent must call this endpoint only when the current human message
directly asks to update, rewrite, reformat, or replace the description.
The endpoint validates the message grant, target id, token, active
agent, and single-use stamp before replacing the description. For
room-scoped chat rows, each addressed agent receives its own token; any
active addressed agent can use only its own token.

## PM Workflow Actions

Mission Control now grants role-aware task workflow actions through the
same native PM-channel turns used for task comments. Workflow turns carry
the full task context packet, the exact required action, and a scoped
token for:

```text
POST /api/agent/tasks/<taskId>/workflow
```

Allowed actions are `start`, `ready_for_review`, `review_feedback`,
`review_done`, and `triage_to_todo`. PM validates the addressed agent,
task assignee/reviewer role, task status, and parent Epic status before
writing. Agent replies to workflow turns are stored as normal task
comments.

Backlog assignment is planning/opinion only: the assigned agent replies
with a task-comment implementation plan and does not change status.
`To Do` is the approval-to-execute signal: the assigned agent moves the
task to `In Progress` and starts immediately. `Review` is only for
completed implementation review.

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
