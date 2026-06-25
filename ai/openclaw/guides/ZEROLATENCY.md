# ZEROLATENCY.md

Zero Latency is the local project-management web UI for the OpenClaw
agent fleet — the branded name for the **PM webapp** that lives in
[`../../web`](../../web) and is served at `agents.vixi.au`. "PM" remains
the internal codename for services, env vars, database tables, and the
OpenClaw `pm` channel.

This file is the **agent-facing interface guide**: what surfaces exist,
what fields agents read/write, and how PM-channel turns flow. Workflow
*behaviour* rules (picking work, status transitions, Action Plans,
reviewing, chat etiquette, proposals, enforcement) live in
[`../WORKFLOW.md`](../WORKFLOW.md) § *Working a Zero Latency task* — the
single workflow authority. If this file and `WORKFLOW.md` ever conflict,
`WORKFLOW.md` wins.

For the **developer/operator reference** (code architecture, Prisma
schema, env vars, deployment, library layout), see
[`ai/web/README.md`](../../web/README.md).

## Quick index

| When you are about to... | Read |
|---|---|
| Reply in PM chat or task comments | [`../WORKFLOW.md`](../WORKFLOW.md) § *Working a Zero Latency task* |
| Choose the next PM task | [`../WORKFLOW.md`](../WORKFLOW.md) § *Picking your next task* |
| Start an assigned PM task | [`../WORKFLOW.md`](../WORKFLOW.md) § *Working a Zero Latency task* |
| Assign, review, or mutate PM work | [`../WORKFLOW.md`](../WORKFLOW.md) § *Assignment and ownership* |
| Propose new PM work items | [`../WORKFLOW.md`](../WORKFLOW.md) § *Work-item proposals* |
| Operate or debug PM workflow automation | [`../WORKFLOW.md`](../WORKFLOW.md) § *Zero Latency workflow enforcement* |
| Understand the PM webapp routes / tabs / fields | [Surfaces](#surfaces) below |
| Read the full agent runtime contract | [Agent runtime contract](#agent-runtime-contract) below |
| Read the full agent PM API contract | [`ai/web/docs/agent-pm-api.md`](../../web/docs/agent-pm-api.md) |
| Read the full agent interaction contract | [`ai/web/docs/agent-interaction.md`](../../web/docs/agent-interaction.md) |
| Deploy or operate the PM webapp | [`ai/web/README.md`](../../web/README.md) · [`ai/web/deploy/README.md`](../../web/deploy/README.md) |

## Zero Latency statuses

```text
Backlog | To Do | In Progress | Review | Done
```

See [`../WORKFLOW.md`](../WORKFLOW.md) § *Picking your next task* and
§ *Working a Zero Latency task* for what each status authorises.

---

## Surfaces

### Project workspace

Every project is wrapped in a shared layout with a tab bar — **Board ·
Epics · Library · Settings · Bin**.

| Route | Purpose |
|---|---|
| `app/(app)/projects` | projects list + inline create. |
| `app/(app)/projects/bin` | project-level soft-delete bin (30-day TTL restores). |
| `app/(app)/projects/[slug]` | kanban board — four workflow columns (To Do · In Progress · Review · Done) with drag-and-drop; Backlog is a separate table below with a show/hide toggle. Done cards older than `doneTtlDays` drop off. Task cards show the current workflow actor + `updated` time. |
| `app/(app)/projects/[slug]/tasks/[taskId]` | task editor — two-column. **Main**: inline title, markdown description editor, sub-tasks progress checklist, attachments, comments. **Sidebar**: status, assignee, reviewer, epic picker, dates. |
| `app/(app)/projects/[slug]/epics` | epic list (status filter: open/done/archived) + inline create. |
| `app/(app)/projects/[slug]/epics/[epicId]` | epic detail — assignee + acting manager, status, attachments, tasks grouped by their own status, chat sidebar, Delete. |
| `app/(app)/projects/[slug]/library` | every attachment under the project (task + epic) in one list; excludes files whose parent is in the bin. |
| `app/(app)/projects/[slug]/settings` | repository path, default git identity, default assignee/reviewer pickers, Done-card TTL, project delete, recent-activity agenda. Admin (`zeh`) on git/worktree-exposed projects also sees **Worktree live preview**. |
| `app/(app)/projects/[slug]/bin` | soft-delete bin for deleted Epics + Tasks (7-day TTL); per-row Restore + "Restore + N children". |

### Agents deck

| Route | Purpose |
|---|---|
| `app/(app)/agents` | agents grid; merges PM DB rows with Atlas live snapshot. Admin (`zeh`) gets `Add Agent` + per-card `Edit`/`Delete`. |
| `app/(app)/agents/[agent]` | per-agent deck, three tabs (`?tab=`): **Profile & controls**, **Operations** (models, tickets, current task, lifecycle, listeners), **Activity**. |
| `app/(app)/agents/[agent]/chat` | direct per-agent chat opened from the sidebar CHAT section. |
| `app/(app)/system/activity` | system-wide ActivityLog stream. |
| `app/(app)/system/settings` | system-wide setting defaults. |

### Agent-facing API (loopback / token-scoped, not browser routes)

| Route | Purpose |
|---|---|
| `app/api/tasks/[id]/ack` | agent ack — auto To Do → In Progress, emits `task.ack_ready`. |
| `app/api/tasks/[id]/description` | agent description write-back (one-shot grant). |
| `app/api/epics/[id]/description` | agent Epic description write-back (one-shot grant). |
| `app/api/agent/projects/[projectId]/proposals` | work-item proposal submission (grant-gated, idempotent on `planId`). |
| `app/api/agents/context/{task,epic,project}/[id]` | loopback-only live PM read API; scoped `?grant=` URLs preferred. |
| `app/api/openclaw/pm-channel/stream` | token-scoped native PM channel live partial-reply callback. |
| `app/api/openclaw/pm-channel/reply` | token-scoped native PM channel durable final-reply callback. |
| `app/api/openclaw/pm-channel/events` | auth-gated same-origin SSE stream for the browser while a reply is running. |
| `app/api/agents/[agentId]/chat/reply` | legacy direct chat reply endpoint (native PM channel is the normal path). |
| `app/api/tasks/[id]/chat/reply` | legacy task chat/comment reply endpoint (native PM channel is the normal path). |

---

## Task and Epic fields agents use

- `Project.repositoryPath` — repo path when configured.
- `Project.defaultGitUserName` / `defaultGitUserEmail` — default project
  git identity for commits.
- `Project.defaultAssigneeId` / `defaultReviewerId` — seed the pickers.
- `Project.doneTtlDays` — Done cards older than this drop off the board.
- `Task.branchName` — the branch to use when set.
- `Task.commitPrefix` — prefix to prepend to commit messages when set.
- `Task.actingManagerId` — the reviewer / acting manager (UI label is
  "Reviewer"; the schema column stays `actingManagerId` for audit
  continuity).
- `Task.blockedById` — optional self-FK to a blocking task that must
  reach Done first (cycle-guarded on write).
- `Task.deletedAt` / `Epic.deletedAt` — soft-delete; `!= null` means in
  the bin.
- `Epic.assigneeId` / `Epic.actingManagerId` — Epic-level principals
  (independent of any task's principals or status).
- `Epic.status` — `open` | `done` | `archived`. Tasks under an Epic are
  actionable only when that Epic status is `open`.

---

## Agent runtime contract

Direct PM chat, task chat, task-comment, and Epic chat turns use the
native OpenClaw `pm` channel. The full agent-facing guide lives in
[`ai/web/docs/agent-interaction.md`](../../web/docs/agent-interaction.md) —
read it once when you first encounter a PM-channel turn on a host. The
PM API contract (endpoint shapes, error codes, replication notes) lives
at [`ai/web/docs/agent-pm-api.md`](../../web/docs/agent-pm-api.md).

When a user sends a message that targets an agent, PM:

1. Persists the PM-side row (`DirectAgentChatMessage`,
   `AgentChatMessage`, or `Comment` plus mirrored `AgentChatMessage` for
   comment origins).
2. Resolves an `AgentSessionBinding`, derives the channel session key
   for that surface, records a durable local run/job, and sends or
   queues the turn for the target agent gateway.
3. Builds bounded channel guidance for the current turn off the submit
   path. Task/Epic chat prompts include the recent hot path plus scoped
   live-context grant URLs.

The target gateway verifies the per-agent PM channel Bearer, runs the
OpenClaw channel turn kernel, records the turn in the supplied `pm:`
session, streams partial visible text to `/api/openclaw/pm-channel/stream`,
and posts the durable final answer to `/api/openclaw/pm-channel/reply`.
PM writes the final answer only to the origin channel: direct chat stays
direct, task chat stays task chat, Epic chat stays Epic chat, and
task-comment replies become task comments. Stream events are appended
with monotonically increasing sequence numbers so browser SSE clients
can reconnect with `Last-Event-ID` and replay missed frames.

Visible replies are only for useful contributions: plans, action
results, feedback, blockers, or necessary questions. If an agent has no
new information to add, it replies with the `PM_SILENT_NO_CONTRIBUTION`
sentinel; `/api/openclaw/pm-channel/reply` records a silent completion
activity row and creates no chat/comment bubble.

---

## Deeper docs

- **Developer/operator reference:** [`ai/web/README.md`](../../web/README.md)
  (stack, full route table, library layout, agent fleet, capability map,
  schema, env vars, deployment).
- **Deploy notes:** [`ai/web/deploy/README.md`](../../web/deploy/README.md)
  (files, worktree switcher, branch verifier, service model, first-time
  install).
- **Multi-agent worktree + live preview design:**
  [`ai/web/deploy/MULTI_AGENT_WORKTREES.md`](../../web/deploy/MULTI_AGENT_WORKTREES.md).
- **Agent interaction contract:**
  [`ai/web/docs/agent-interaction.md`](../../web/docs/agent-interaction.md).
- **Agent PM API contract:**
  [`ai/web/docs/agent-pm-api.md`](../../web/docs/agent-pm-api.md).