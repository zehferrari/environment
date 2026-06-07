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
comment also targets the assigned active agent, the task reviewer, the
acting manager of an Open parent Epic, and explicit mentions, with
duplicates removed. If no reviewer or Open Epic manager exists, the task
reporter is the review fallback.

Task and Epic descriptions currently support full markdown preview, but
they do **not** resolve `@mentions` or dispatch mention notifications.
Treat `@username` in descriptions as plain text. If you need an agent to
respond, mention them in a task comment or start the appropriate PM chat.

Rules:

- Read the whole PM context packet before answering: task title,
  description, status, project, assignee, reviewer, parent/subtask
  context, Epic context, recent comments, full active Task/Epic
  Action Plan history for the item once invited or mentioned, activity,
  attachment metadata, and extracted attachment text when available.
- Golden rule: if there is no new information, concrete action result,
  required plan, review feedback, blocker, or necessary question, stay
  silent. Do not post acknowledgements, restatements, progress filler,
  or "nothing to add" comments.
- Do not post workflow-status acknowledgements after calling a workflow
  endpoint. If the endpoint handled the turn, reply with only the exact
  silent token and no other text.
- For simple implementation tasks, do not discuss routine implementation
  choices in PM comments. Move `To Do` to `In Progress`, do the work,
  then move to `Review` with one concise evidence note.
- If you are the resolved reviewer and approve the work, use the
  `review_done` workflow action instead of posting an approval-only
  comment.
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
2. **`To Do` tasks assigned to you and approved to start.** If
   `approved_on` is set, move the task to `In Progress` through PM
   workflow and start immediately. If `approved_on` is empty, post one
   technical plan in the task's Action Plan tab and wait for reviewer or
   reporter approval.
3. **`In Progress` tasks waiting on reviewer/manager/reporter input.**
   Move the task to `Review` through PM workflow with one concise note
   explaining the blocker, question, or response needed. Do not leave
   waiting work in `In Progress`.
4. **Assigned tasks in other non-terminal states.** Act only if the PM
   event or human request clearly asks for your response.
5. **Assigned `Backlog` tasks**: planning/opinion only. Read the full
   context and post your implementation plan or perspective in the
   Action Plan tab. Do not change status and do not start work.
6. **Unassigned tasks**: do not claim them. If one looks important,
   report the finding in PM or hand it to the manager / zeh for
   assignment.
7. **Nothing actionable**: send `HEARTBEAT_OK` and stop. The next PM
   event, email, or Telegram request will wake you.

---

## Working a Zero Latency task

1. Read the full PM task context: description, comments, task chat,
   attachments, activity, parent/subtasks, Epic, assignee, reviewer, and
   current status.
2. Determine your role from the PM task/Epic context and the latest human
   instruction, not from persona alone.
3. **`Backlog` means planning/opinion only.** If you are assigned while
   the task is in Backlog, read all context and comments, then post one
   technical Action Plan message with your implementation plan or
   perspective. Do not change status and do not start implementation.
4. If the task is unassigned, do not assign it to yourself and do not
   start implementation.
5. You may implement only when the PM task is explicitly assigned to you
   by zeh, by a valid handoff, or by a PM event that clearly grants you
   ownership.
6. `To Do` is actionable only after the Action Plan is approved. When a
   task assigned to you reaches `To Do`, check `approved_on`. If it is
   empty, post the Action Plan and wait. If it is set, move the task to
   `In Progress` through the PM workflow endpoint and start work.
7. PM no longer auto-starts unapproved assigned work. Older wake/ack
   clients are blocked from moving `To Do` to `In Progress` until
   `approved_on` is set. Do not use hidden routes or direct database
   edits to force status.
8. If blocked before starting, do not start unless explicitly instructed.
   If a blocker appears after starting and you need reviewer, manager, or
   reporter input, move the task to `Review` through the PM workflow
   endpoint with one concise note. Wait until the blocker is actually
   done/landed, not merely approved.
9. The Action Plan message is mandatory for every new assignment before
   implementation. The resolved reviewer or reporter must discuss needed
   adjustments in Action Plan, or approve with a concise note explaining
   why the plan is acceptable or naming any constraints; that approval
   stamps `approved_on` and `approved_by`. When a Task Action Plan has an
   explicit `Deliverables`, `Implementation steps`, `Checklist`,
   `Subtasks`, or `Milestones` section and the Task has no subtasks yet,
   PM creates those entries as ordered task-local subtasks for progress
   tracking. Bullets under `Inputs`, `Rule logic`, context, risks, or open
   questions are not subtasks.
   Subtasks may be created only by the task assignee, only after the Task
   Action Plan is approved, and only when the Task has no existing child
   subtasks. Epic implementation tasks may be created only by the Epic
   acting manager, only after the Epic Action Plan is approved, and only
   when the Epic has no existing child tasks.
10. If your task is in `Review` because you were waiting for feedback or
    an external response, and that response arrives, resume with workflow
    action `start`, complete the follow-up, then call `ready_for_review`
    again with one concise visible note.
11. For code tasks, use the PM project settings and task fields:
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
14. On completion, move the task to `Review` through the PM workflow
    endpoint and include one concise note with branch, commit, tests, and
    residual risk when applicable. Sign formal completion notes.
15. When you are waiting for reviewer/manager/reporter feedback or
    response, move the task to `Review` through the PM workflow endpoint
    with one concise blocker/question note. If you are the resolved reviewer, review
    the completed work, move it to `Done` when satisfied without posting
    an approval-only comment, or leave concrete feedback/blockers while
    keeping it in `Review`.
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
- Role-aware PM workflow actions are allowed only through the native
  workflow endpoint supplied in a PM-channel turn. Assignees may
  `start` and `ready_for_review`; the resolved reviewer may
  `review_feedback`, `review_done`, or `triage_to_todo`.
- Review owner resolution is: task Reviewer / acting manager, then the
  acting manager of an Open parent Epic, then the task reporter.
- Tasks under an Epic are actionable only when that Epic status is
  `Open`.
- If a PM event says "assigned to me" but the actor is yourself, treat it
  as a policy error and do not start work.

---

## Work-item proposals

Zero Latency supports grant-scoped **propose -> approve** work-item
planning from direct PM chat, Task/Epic Action Plan turns, and
human-authored task comments that wake an agent.

Use this only when all of these are true:

- The turn is project-scoped: either a direct chat attached to a target
  project, a Task/Epic Action Plan message, or a human-authored task
  comment mirrored into your PM channel.
- Direct project chats include short-lived context-read grants for the
  project and for same-project Task/Epic links in the human message. Use
  those loopback URLs as the source of truth; do not try to open public
  PM URLs from your browser-less agent environment.
- The current message was authored by a human, which grants proposal
  capability for explicit project-change requests by default.
- The PM turn supplied a single-use grant token and proposal endpoint.
  In Task/Epic Action Plan and task-comment turns, that grant is
  single-use per addressed agent, so `All Coders` or multi-agent task
  comments can submit independent proposals from the same human message.

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
grant for that message. Agent-authored comments and PM workflow
notifications do not grant work-item management.

---

## Zero Latency and code

Zero Latency owns the local work-item lifecycle. Bitbucket owns
branch/push/PR mechanics for Bitbucket-backed repos.

- Use PM task fields for `branchName` and `commitPrefix`.
- Put completion evidence in PM: branch, commit, tests, residual risk.
- Do not rely on Git commit side effects to communicate required status.
- For shared repos, follow [`BITBUCKET.md`](./BITBUCKET.md) and
  [`CODE_REPOS.md`](./CODE_REPOS.md).
