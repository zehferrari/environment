# Agent Interaction Guide

This guide is the agent-facing contract for interacting with the PM
system at `agents.vixi.au`. It covers what agents can do today, what
they must not assume, and where future project/epic/task actions should
land.

## Current Contract

Direct PM chat, task chat, and task-comment agent replies use the
native OpenClaw `pm` channel. PM posts the user turn to the target
agent's local OpenClaw gateway:

```text
POST http://127.0.0.1:<gateway_port>/pm-channel/ingest
Authorization: Bearer <pm channel token>
Body: {
  "version": 1,
  "kind": "direct" | "task-chat" | "task-comment",
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
events, but chat and task-comment replies should not use `/hooks/wake`
or prompt-visible callback contracts.

## Task Comments And Chat

PM creates an `AgentSessionBinding` for every direct/task conversation
and sends that `pm:` key to the OpenClaw `pm` channel. OpenClaw owns the
chat session from there: inbound recording, model dispatch, and final
reply delivery are channel behavior, not instructions shown to the
model.

Task chat/comment payloads still include a PM context packet in
`contextText`. PM is the source of truth for task, Epic, comments,
activity, and attachment extracts; OpenClaw is the owner of the channel
session and communication lifecycle.

Replies must stay in the origin channel:

- User wrote in task chat -> agent reply is stored in task chat only.
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
    "kind": "direct | task-chat | task-comment",
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

The OpenClaw `pm` channel posts final visible replies to PM:

```json
{
  "version": 1,
  "channel": "pm",
  "target": {
    "kind": "direct | task-chat | task-comment",
    "agentSlug": "<agent slug>",
    "messageId": "<origin PM message id>"
  },
  "text": "<agent reply text>"
}
```

The route is `POST /api/openclaw/pm-channel/reply` with
`Authorization: Bearer <PM_OPENCLAW_CHANNEL_TOKEN>`. PM validates the
target and active agent user before writing the reply to direct chat,
task chat, or task comments.

## Context Requirements

Agents should answer from the whole provided context, not only the last
line. The PM prompt can include:

- task title, description, status, project, assignee, reviewer, and
  parent/subtask context;
- Epic title, status, description, assignee, and acting-manager context;
- recent task comments;
- relevant task chat history for the addressed agent;
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

## Future Agent Actions

Future agent write actions should be added as explicit native channel
tools or service-token API endpoints. Do not let agents mutate the
database directly.

Expected future capabilities:

- create projects;
- create, update, assign, and archive epics;
- create, update, assign, comment on, and transition tasks;
- upload or attach files;
- link tasks to epics and parent tasks;
- request human approval for sensitive operations.

Each future action should follow the same shape:

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
