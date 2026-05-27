# ZEROLATENCY.md

Zero Latency is the local project-management web UI for the OpenClaw
agent fleet. The app lives at
`/srv/Code/environment.worktrees/feature_HOMELAB-41-local-project-manager-webapp-/ai/web`
and is served as the PM workspace (`agents.vixi.au`). "PM" remains the
internal codename for services, env vars, database tables, and the
OpenClaw `pm` channel.

Use this file with [`TEAM_WORKFLOW.md`](./TEAM_WORKFLOW.md),
[`ROLES.md`](./ROLES.md), and [`BITBUCKET.md`](./BITBUCKET.md) when a
task comes from Zero Latency rather than Jira.

## Quick index

| When you are about to... | Read |
|---|---|
| Reply in PM chat or task comments | [PM comments and chat](#pm-comments-and-chat) |
| Choose the next PM task | [Picking Zero Latency work](#picking-zero-latency-work) |
| Start an assigned PM task | [Working a Zero Latency task](#working-a-zero-latency-task) |
| Assign, review, or mutate PM work | [Assignment and workflow mutations](#assignment-and-workflow-mutations) |
| Propose new PM work items | [Work-item proposals](#work-item-proposals) |
| Push code for a PM task | [`BITBUCKET.md`](./BITBUCKET.md) |

---

## PM comments and chat

Zero Latency talks to agents through the native OpenClaw `pm` channel.
The normal channels are:

- direct PM chat from `/agents/<slug>/chat`;
- task chat on a task editor;
- task comments that target an agent.

Task comments support actionable `@mentions`. A mention must match a
known username exactly, including case. When a task comment mentions an
active agent, PM mirrors that comment into the agent's PM channel turn so
the agent can answer back in the original task-comment thread. A task
comment also targets the assigned active agent, even without an explicit
mention.

Task and Epic descriptions currently support full markdown preview, but
they do **not** resolve `@mentions` or dispatch mention notifications.
Treat `@username` in descriptions as plain text. If you need an agent to
respond, mention them in a task comment or start the appropriate PM chat.

Rules:

- Read the whole PM context packet before answering: task title,
  description, status, project, assignee, reviewer, parent/subtask
  context, Epic context, recent comments, full active Task/Epic
  Discussion history for the item once invited or mentioned, activity,
  attachment metadata, and extracted attachment text when available.
- Reply only in the origin channel. If the user wrote in task chat, reply
  in task chat. If the user wrote a task comment, reply as a task comment.
  If the user wrote direct chat, reply in direct chat.
- Do not duplicate the same answer across chat and comments.
- Use markdown for structured answers.
- Use the [`TEAM_WORKFLOW.md` signature](./TEAM_WORKFLOW.md#signature-mandatory)
  for formal task comments, completion notes, and review handoffs. Direct
  PM chat can stay conversational unless the user asks for a formal
  handoff.
- If an attachment matters but its content is not present in the PM
  context packet, say which attachment needs inspection. Do not invent
  attachment contents.

Agents must not write directly to the Prisma SQLite database, infer
hidden endpoints, reuse scoped tokens outside the message/action they
were issued for, or bypass PM workflow rules through filesystem access.

Full runtime contract: `ai/web/docs/agent-interaction.md`.

---

## Picking Zero Latency work

Zero Latency task statuses are:

```text
Backlog | To Do | In Progress | Review | Done
```

After completing a PM task, email, or Telegram task, pick the next PM
task using this priority order:

0. **Explicit PM wake/chat/comment task.** If the current turn names a
   specific PM chat, task comment, assignment event, or
   `~/tasks/current.md` entry, do that first. The task is not complete
   until the requested PM reply/action is done and the queue entry is
   updated out of `QUEUED`.
1. **Unanswered feedback on your Review-stage PM tasks.** A round is
   unanswered when the latest PM comment/chat turn is from someone other
   than you, postdates your last response, and postdates the most recent
   move into `Review`. Oldest comment first. Respond with **concrete
   action** (code change pushed, plan revised, question answered), not
   just acknowledgement.
2. **`To Do` tasks assigned to you and ready to start.** Send the one
   allowed Telegram start notice, acknowledge/start through PM, and work
   in PM.
3. **Assigned tasks in other non-terminal states.** Act only if the PM
   event or human request clearly asks for your response.
4. **`Backlog`**: skip unless zeh explicitly overrides for that specific
   task.
5. **Unassigned tasks**: do not claim them. If one looks important,
   report the finding in PM or hand it to the manager / zeh for
   assignment.
6. **Nothing actionable**: send `HEARTBEAT_OK` and stop. The next PM
   event, email, or Telegram request will wake you.

---

## Working a Zero Latency task

1. Read the full PM task context: description, comments, task chat,
   attachments, activity, parent/subtasks, Epic, assignee, reviewer, and
   current status.
2. Determine your role from the PM task/Epic context and the latest human
   instruction, not from persona alone.
3. **`Backlog` -> ignore completely** unless zeh explicitly overrides for
   that specific task. No queue, wake, comment, transition, or work.
4. If the task is unassigned, do not assign it to yourself and do not
   start implementation.
5. You may implement only when the PM task is explicitly assigned to you
   by zeh, by a valid handoff, or by a PM event that clearly grants you
   ownership.
6. Send exactly **one** concise Telegram start notice to zeh after
   accepting an assigned PM task. After that, communicate about the task
   only in PM unless zeh redirects.
7. PM can auto-transition an assigned agent's task from `To Do` to
   `In Progress` when the agent acknowledges the task. Do not use hidden
   routes or direct database edits to force status.
8. If blocked, do not start unless explicitly instructed. If a blocker
   exists, wait until it is actually done/landed, not merely approved.
9. For risky / ambiguous / multi-step work needing approval, post a
   concise plan in PM **before** implementation.
10. For code tasks, use the PM project settings and task fields:
    - `Project.repositoryPath` tells you the repo path when configured.
    - `Project.defaultGitUserName` / `defaultGitUserEmail` describe the
      default project git identity.
    - `Task.branchName` is the branch to use when set.
    - `Task.commitPrefix` is the prefix to prepend to commit messages
      when set.
11. For repos under `/srv/Code/` or backed by Bitbucket, follow
    [`BITBUCKET.md`](./BITBUCKET.md) and [`CODE_REPOS.md`](./CODE_REPOS.md).
    If a shared repo task lacks a branch name, ask in PM and wait.
12. Run relevant tests/builds, or state plainly what could not be tested.
13. Push the branch when code is ready. Do **not** create or update a pull
    request. PR creation and landing are human-only.
14. On completion, post a concise PM completion comment with branch,
    commit, tests, and residual risk. Sign formal completion notes.
15. Do **not** move PM tasks to `Review` or `Done` unless zeh explicitly
    instructs you and the PM workflow permits it. In the current PM rules,
    Review and Done are explicit human actions for agents.
16. When you flip the matching `~/tasks/current.md` entry to a terminal
    status, move it to `~/tasks/log.md` in the same edit. See
    [TEAM_WORKFLOW.md -> Maintaining tasks/current.md](./TEAM_WORKFLOW.md#maintaining-taskscurrentmd).

---

## Assignment and workflow mutations

- Before any PM mutation, run this preflight:
  - Is this an Epic or a Task?
  - Am I assigned to it?
  - Am I the reviewer / acting manager?
  - Is this a child of an Epic or task I am managing?
  - Is this assigned to me by zeh or a valid handoff?
  - Is it `Backlog`?
  - If none of those prove ownership or review duty: no mutation and no work.
- Never assign a PM task to yourself.
- Never set yourself as reviewer / acting manager.
- Unassigned implementation tasks are not automatically yours, even if
  they are in `To Do` or arrive through a PM event.
- A coordinating agent may hand off work only when the task is ready and
  not blocked.
- Agents may not transition into or out of `Review` / `Done` through PM
  automation. Those states require explicit human action today.
- If a PM event says "assigned to me" but the actor is yourself, treat it
  as a policy error and do not start work.

---

## Work-item proposals

Zero Latency supports grant-scoped **propose -> approve** work-item
planning from direct PM chat and Task/Epic Discussion turns.

Use this only when all of these are true:

- The turn is project-scoped: either a direct chat attached to a target
  project, or a Task/Epic Discussion message.
- The current message was authored by a human, which grants proposal
  capability for explicit project-change requests by default.
- The PM turn supplied a single-use grant token and proposal endpoint.
  In Task/Epic Discussion, that grant is single-use per addressed agent,
  so `All Coders` can submit independent proposals from the same human
  message.

The agent submits a typed change-set to:

```text
POST /api/agent/projects/<projectId>/proposals
```

Allowed operations are:

- `create_epic`
- `create_task`
- `create_subtask`
- `update_epic`
- `update_task`
- `comment_task`

Rules:

- New items use `tmp:` refs so later operations can refer to them.
- Existing items are addressed by real IDs from the PM project context.
- `assignee` and `actingManager` values are usernames or `null`.
- New tasks land in `Backlog`; new epics land `open`.
- PM dry-run-validates every operation under the human-triggered grant:
  active principals, project scoping, hierarchy, known statuses, and
  valid task-status transitions are checked before the proposal is stored.
- A valid proposal is stored pending. Nothing changes on the board until
  a human clicks Apply.
- Re-submitting the same `planId` is idempotent.

Do not create tasks, epics, comments, or status changes by writing the
database directly. Use the grant-scoped endpoint only when PM supplied a
grant for that message.

---

## Zero Latency and code

Zero Latency owns the local work-item lifecycle. Bitbucket owns
branch/push/PR mechanics for Bitbucket-backed repos.

- Use PM task fields for `branchName` and `commitPrefix`.
- Put completion evidence in PM: branch, commit, tests, residual risk.
- Do not rely on Git commit side effects to communicate required status.
- For shared repos, follow [`BITBUCKET.md`](./BITBUCKET.md) and
  [`CODE_REPOS.md`](./CODE_REPOS.md).
