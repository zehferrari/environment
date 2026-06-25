# WORKFLOW.md

The team's **playbook**, organised by action. This file is the **index and
common rules** — keep it loaded. Source-specific and role-specific details
live in focused guides under [`guides/`](./guides); open the one that
matches the action you're about to take, then close it when done. You do
not need to load a guide you're not using.

`AGENTS.md` is the boot manifest (always-on rules, operating baseline).
[`guides/ROLES.md`](./guides/ROLES.md) is the task-role manual. This file
is the **single authority** for general process and task handling. If any
older doc conflicts with this file, this file wins.

## Quick index

| When you are about to... | Read |
|---|---|
| Send an outbound source-channel comment or email | [Sending an outbound](#sending-an-outbound) |
| Receive a direct mention or addressed comment | [Receiving a mention](#receiving-a-mention) |
| Pick your next task after finishing one | [Picking your next task](#picking-your-next-task) |
| Start work on an assigned Jira issue | [`guides/JIRA.md`](./guides/JIRA.md) § *Working a Jira ticket* |
| Start work on an assigned Zero Latency / PM task | [Working a Zero Latency task](#working-a-zero-latency-task) |
| Understand the PM webapp interface (routes, tabs, fields) | [`guides/ZEROLATENCY.md`](./guides/ZEROLATENCY.md) |
| See unassigned work or want to assign work | [Assignment and ownership](#assignment-and-ownership) |
| Approve an Action Plan | [Action Plan approval](#action-plan-approval) |
| Decompose an Epic into tasks or a task into subtasks | [Subtasks and Epic task ordering](#subtasks-and-epic-task-ordering) |
| Operate or debug Zero Latency workflow automation | [Zero Latency workflow enforcement](#zero-latency-workflow-enforcement) |
| Push code, prepare a branch, or think a PR is needed | [`guides/BITBUCKET.md`](./guides/BITBUCKET.md) and [Code and PR boundary](#code-and-pr-boundary) |
| Shared `/srv/Code` checkout mechanics and `claim-branch` | [`guides/CODE_REPOS.md`](./guides/CODE_REPOS.md) |
| Hand off work to another agent | [Task handoff](#task-handoff) |
| Review someone else's work | [Reviewing](#reviewing) |
| Handle email | [Email](#email) |
| Send a Telegram message | [Telegram](#telegram) |
| Touch a system or service | [System / service operations](#system--service-operations) |
| Close out a `tasks/current.md` entry | [Maintaining `tasks/current.md`](#maintaining-taskscurrentmd) |
| Save what you learned | [Knowledge handling](#knowledge-handling) |
| Escalate to another agent or to zeh | [Escalation](#escalation) |
| You are the monitor agent | [`guides/ROLES.md`](./guides/ROLES.md) § *Monitor* + [`guides/INCIDENT_HANDLING.md`](./guides/INCIDENT_HANDLING.md) + [`guides/MONITORING.md`](./guides/MONITORING.md) + [`guides/SERVICES.md`](./guides/SERVICES.md) |

---

## Sending an outbound

Applies to **source-channel comments, status updates, completion notes,
email replies, and review handoffs**. Does **not** apply to Telegram
(see [Telegram](#telegram)).

### Format

Reply content must be **proper markdown** when the destination supports
markdown or the helper converts markdown for that destination:

- Separate paragraphs with blank lines (single newlines stay inside one
  paragraph).
- Bullet (`- `) or numbered (`1. `) lists for findings, steps, options.
- ATX headings (`## Section`) when the reply has multiple sections.
- Fenced code blocks (```` ``` ````) for code/config/log; inline `code`
  for filenames, identifiers, commands, env vars.
- Pipe tables for comparisons or summaries when supported by the
  destination.
- Cite work item keys/IDs, PR numbers, branch names, commit hashes, and
  file paths verbatim.

Discord/WhatsApp consume different formatting: no markdown tables,
Discord links wrapped in `<>`, WhatsApp uses **bold**/CAPS instead of
headings.

### Email sender header (mandatory)

Every outbound email **must** set the `From:` header to the full
`Name <email>` form pulled from your registry record - never bare
email address alone. The recipient should see who's writing, not just
the mailbox:

```text
From: <name field from agents.json> <<email field from agents.json>>
```

Worked examples (do not hardcode these - read your own record):

```text
From: Asdrubal Irwin <a@zeh.me>
From: Monitor Agent <monitor@...>
```

- Pull `name` and `email` verbatim from your entry in
  `/etc/openclaw/agents.json` - that's the canonical mapping.
- The skill helpers (`gmail-send.js`, `mime.js`,
  `local-mail/send.js`, etc) build the `From:` header from these
  fields automatically; don't override unless zeh explicitly asks.
- If the helper you're using doesn't populate the display name, fix
  the helper. Don't ship messages with `From: a@zeh.me` only -
  recipients have no easy way to tell which agent wrote.
- This applies to **every** outbound channel that takes a `From:` header
  (Gmail API, SMTP via local Maildir, automated replies). Telegram has no
  equivalent - its persona comes from the bot handle in `telegram.bot`.

### Passing the body (do not pass a path as the body)

Each sender takes the body **as the message contents itself**, not as a
path to a file you want loaded. The mistake is easy:
`gmail-send.js zeh@example.com "Subject" /tmp/reply.txt` sends an email
whose body is the literal string `/tmp/reply.txt`. The recipient sees
the path, not your message.

Three correct ways to pass a body:

```bash
# 1) Literal string on the command line (small bodies)
node gmail-send.js zeh@example.com "Subject" "Hi zeh, ..."

# 2) From a file - use --body-file (recommended for multi-line / long)
node gmail-send.js zeh@example.com "Subject" --body-file=/tmp/reply.txt

# 3) From stdin - pass "-" as the body
cat /tmp/reply.txt | node gmail-send.js zeh@example.com "Subject" -
```

`local-mail/maildir.js send` and `reply` accept the same three forms.
If you accidentally pass a path-shaped argument as the body and the file
exists, the script errors out with "looks like a path; use --body-file"
rather than silently sending the path string as the body.

### Signature (mandatory)

End every formal source-channel or email outbound with this signature on
its own paragraph:

```text
--
<First Name>
<provider>/<model>
```

- Two hyphens, exactly.
- **First name only** - the first token of your `name` field in
  `agents.json`. Not the full display name.
- `<provider>/<model>` plain, no `Model:` prefix. Use the **actual**
  current runtime model, not a remembered default. If unclear:
  `openclaw sessions --active 10 --json`.

Destination helpers may render the provider/model line subdued
(smaller, grey). You write plain text; helpers do the styling.

Mandatory even for short / urgent / acknowledgement messages.
**Forbidden** in Telegram.

---

## Receiving a mention

If you are directly mentioned or explicitly addressed in a work item,
comment thread, chat, email, or webhook wake, you **must** reply in the
source channel. Silence is not an option. This is the default rule for
every source system — Jira, Zero Latency / PM, email, Telegram.

- **You can help**: do the work, reply with results, sign when the
  channel calls for the signature rule.
- **Nothing useful to add**: follow the source-specific rule. Zero
  Latency / PM uses a silent no-contribution path, so do not post a
  visible "nothing to add" comment there. Other channels may still
  require a brief acknowledgement and redirection.
- **Work belongs to someone else**: reply in the thread only. Do not
  transition, assign, or take over without explicit handoff.
- **Backlog exception**: a reply is mandatory, but **no action** may be
  applied to an Epic or Task set as `Backlog`. Do not queue, transition,
  implement, assign, or start work on a Backlog item even if you are
  mentioned in it. Post the reply only and stop. The only override is an
  explicit zeh instruction for that specific ticket.

Mention monitoring SLA (Jira): if you do not reply within 15 minutes,
`ai-monitor` fires `mention-awaiting-reply` warn; at 60 minutes or more
it fires crit. See [`guides/JIRA.md`](./guides/JIRA.md) § *Jira @-mentions*.

---

## Picking your next task

After completing a work item, email, or Telegram task, pick the next task
using this **fixed priority order**. Tier 1 must be exhausted before
tier 2 or 3. The order applies to both Jira and Zero Latency / PM; only
the status names differ (see [`guides/JIRA.md`](./guides/JIRA.md) § *Picking Jira work* and [`guides/ZEROLATENCY.md`](./guides/ZEROLATENCY.md) § *Picking Zero Latency work* for the source-specific names).

0. **Explicit wake/system-event task.** If the current turn says to
   process a specific queued source-channel item, email, Telegram
   request, Jira/PM mention or ticket, or `~/tasks/current.md` entry, do
   that first. The task is not complete until the requested source-channel
   reply/action is done and the task entry is updated out of `QUEUED`.
1. **Unanswered feedback on your review-stage work.** A feedback round is
   unanswered when the latest source-channel comment/request is from
   someone other than you, postdates your last response, and postdates
   the most recent move into review. Oldest comment first. Respond with
   **concrete action** (code change pushed, plan revised, question
   answered), not just acknowledgement.
2. **Approved work assigned to you and ready to start.** Follow the
   source-specific queue/status rules before acting.
3. **Directly assigned work that is not yet in an approved ready state.**
   Start only when the source-specific rules allow it.
4. **Backlog/deferred work**: follow source-specific rules. In Jira this
   normally means skip unless zeh overrides. In Zero Latency / PM, a
   Backlog assignment is actionable only as a plan/opinion comment and
   does not authorize implementation.
5. **Unassigned work**: do not claim it. If one looks important, report
   the finding in the source channel or hand it to the manager / zeh for
   assignment.
6. **Nothing actionable**: send `HEARTBEAT_OK` and stop. Do not poll
   external systems; the next webhook, PM event, email, or Telegram
   request will wake you.

### Pressure-relief escape hatch

If three or more unanswered feedback rounds are queued and ready-to-start
assigned work has had zero progress for more than 24 hours, send zeh
**one** Telegram one-liner:

```text
<your-name>: review pressure starving build - N feedback rounds queued, M ready tasks idle >24h
```

Then continue feedback-first. Max one such Telegram per 24 hours per
agent.

---

## Action Plan approval

Every Epic and Task assignment requires a concrete Action Plan **before**
implementation begins. The approver chain, in order:

1. **Task reviewer** — the first approver. If the task has a reviewer set,
   they review and approve the plan.
2. **Epic acting manager** — if the reviewer is empty, the acting manager
   of the task's Open parent Epic approves.
3. **Task reporter** — if there is no reviewer and no Open parent Epic
   acting manager, the reporter approves.

The approver reviews the Action Plan in the Action Plan tab. If it needs
adjustment, they reply there with one consolidated feedback comment. If
it is acceptable, they approve with a concise note explaining why the
plan is acceptable or naming any constraints; approval stamps
`approved_on` and `approved_by`.

Approval stamps `approved_on` and `approved_by` on the task. Only an
approved `To Do` task can move to `In Progress`. Do not start
implementation before the plan is approved unless zeh explicitly
overrides for that specific task.

When an Action Plan has an explicit `Deliverables`, `Implementation
steps`, `Checklist`, `Subtasks`, or `Milestones` section and the Task has
no subtasks yet, PM creates those entries as ordered task-local subtasks
so progress can be tracked against the approved plan. Bullets under
`Inputs`, `Rule logic`, context, risks, or open questions are not
subtasks.

---

## Subtasks and Epic task ordering

Two distinct decomposition levels, each with its own creator and gate:

### Epic implementation tasks (created by the Epic acting manager)

- A manager assigned to an Epic posts the **Epic Action Plan** first. The
  first thing the manager does on an assigned Epic is create a detailed
  plan of action.
- Once the Epic Action Plan is approved, the Epic acting manager creates
  **all** the tasks required to implement the Epic.
- To clearly display the steps order, each child task title **must** start
  with a sequential number: `1.`, `2.`, `3.`, matching the intended
  implementation order.
- Epic implementation tasks may be created only by the Epic acting
  manager, only after the Epic Action Plan is approved, and only when the
  Epic has no existing child tasks. Additional work inside an existing
  Task is tracked as task-local subtasks, not new Epic tasks.
- The manager moves the ordered tasks to `To Do` and assigns only the
  first executable task.

### Task-local subtasks (created by the task assignee/reviewer)

- A reviewer assigned to a Task posts the **Task Action Plan** first. The
  first thing the reviewer does on an assigned Task is create a detailed
  plan of action.
- Once the Task Action Plan is approved, if applicable, the reviewer
  should divide the task into subtasks to allow multiple subagents working
  in the same task in parallel.
- Subtasks are a **lightweight progress checklist** (`SubTask` model: text
  + `completedAt` + optional `minutesSpent`), not child Tasks — they have
  no assignee, reviewer, status, key, or board presence.
- Subtasks may be created only by the task assignee, only after the Task
  Action Plan is approved.
- When a task bounces back from `Review`, the assignee adds a subtask per
  feedback item so the progress bar stays honest.
- The assignee must set each subtask as `Done` (tick it) as it completes.
- A task's board card shows a segmented progress bar (one node per
  subtask, filling on an orange→green gradient as completion rises). To
  Do reads as an empty bar.
- Subtasks are checklist/progress rows and must not be used as the next
  Epic implementation task. After `review_done`, PM assigns the next
  unassigned top-level `To Do` task in the same Open Epic — never a
  subtask.

---

## Working a Zero Latency task

Zero Latency / PM-specific workflow. Use this section together with
[`guides/ZEROLATENCY.md`](./guides/ZEROLATENCY.md) (the interface guide:
routes, tabs, fields, runtime contract) and
[`guides/BITBUCKET.md`](./guides/BITBUCKET.md) / [`guides/CODE_REPOS.md`](./guides/CODE_REPOS.md)
for code-host mechanics. For the Jira equivalent, see
[`guides/JIRA.md`](./guides/JIRA.md).

### Zero Latency statuses

```text
Backlog | To Do | In Progress | Review | Done
```

### PM comments and chat

Zero Latency talks to agents through the native OpenClaw `pm` channel.
The normal channels are direct PM chat (`/agents/<slug>/chat`), task chat
on a task editor, and task comments that target an agent.

Task comments support actionable `@mentions`. A mention must match a
known username exactly, including case. When a task comment mentions an
active agent, PM mirrors that comment into the agent's PM channel turn so
the agent can answer back in the original task-comment thread. A task
comment also targets the assigned active agent, the task reviewer, the
acting manager of an Open parent Epic, and explicit mentions, with
duplicates removed. If no reviewer or Open Epic manager exists, the task
reporter is the review fallback.

Task and Epic descriptions support full markdown preview, but they do
**not** resolve `@mentions` or dispatch mention notifications. Treat
`@username` in descriptions as plain text. If you need an agent to
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
- Reply only in the origin channel. If the user wrote in task chat, reply
  in task chat. If the user wrote a task comment, reply as a task comment.
  If the user wrote direct chat, reply in direct chat.
- Do not duplicate the same answer across chat and comments.
- Use markdown for structured answers.
- Use the [signature](#signature-mandatory) for formal task comments,
  completion notes, and review handoffs. Direct PM chat can stay
  conversational unless the user asks for a formal handoff.
- If an attachment matters but its content is not present in the PM
  context packet, say which attachment needs inspection. Do not invent
  attachment contents.

Agents must not write directly to the Prisma SQLite database, infer
hidden endpoints, reuse scoped tokens outside the message/action they
were issued for, or bypass PM workflow rules through filesystem access.

Full runtime contract: [`guides/ZEROLATENCY.md`](./guides/ZEROLATENCY.md)
§ *Agent runtime contract* and `ai/web/docs/agent-interaction.md`.

### Picking Zero Latency work

After completing a PM task, email, or Telegram task, pick the next PM
task using the [fixed priority order](#picking-your-next-task). Zero
Latency / PM queue/status names:

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
   technical plan in the task's Action Plan tab and wait for approval.
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

### Working a Zero Latency task

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
9. **Action Plan.** The Action Plan message is mandatory for every new
   assignment before implementation. The approver chain is defined in
   [Action Plan approval](#action-plan-approval). When a Task Action Plan
   has an explicit `Deliverables`, `Implementation steps`, `Checklist`,
   `Subtasks`, or `Milestones` section and the Task has no subtasks yet,
   PM creates those entries as ordered task-local subtasks for progress
   tracking. Bullets under `Inputs`, `Rule logic`, context, risks, or
   open questions are not subtasks.
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
12. For repos under `/srv/Code/` or backed by Bitbucket, follow
    [`guides/BITBUCKET.md`](./guides/BITBUCKET.md) and [`guides/CODE_REPOS.md`](./guides/CODE_REPOS.md).
    If a shared repo task lacks a branch name, ask in PM and wait.
13. Run relevant tests/builds, or state plainly what could not be tested.
14. Push the branch when code is ready. Do **not** create or update a pull
    request. PR creation and landing are human-only.
15. On completion, move the task to `Review` through the PM workflow
    endpoint and include one concise note with branch, commit, tests, and
    residual risk when applicable. Sign formal completion notes.
16. When you are waiting for reviewer/manager/reporter feedback or
    response, move the task to `Review` through the PM workflow endpoint
    with one concise blocker/question note. If you are the resolved
    reviewer, review the completed work, move it to `Done` when satisfied
    without posting an approval-only comment, or leave concrete
    feedback/blockers while keeping it in `Review`.
17. When you flip the matching `~/tasks/current.md` entry to a terminal
    status, move it to `~/tasks/log.md` in the same edit. See
    [Maintaining `tasks/current.md`](#maintaining-taskscurrentmd).

### Assignment and workflow mutations

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

### Work-item proposals

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

Allowed operations are `create_epic`, `create_task`, `create_subtask`,
`update_epic`, `update_task`, `comment_task`.

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

### Zero Latency workflow enforcement

The durable workflow contract for the local PM workflow.

**Manager / assignee / reviewer loop:**

1. A manager opens an Epic and posts the Epic Action Plan. Once approved,
   the manager creates all the implementation tasks, with titles starting
   `1.`, `2.`, `3.` in implementation order.
2. The manager moves the ordered tasks to `To Do` and assigns only the
   first executable task.
3. The assignee (or reviewer) posts one concrete technical Action Plan in
   the task's Action Plan tab before implementation. See
   [Action Plan approval](#action-plan-approval) for the approver chain.
4. The assignee starts the approved task by moving it to `In Progress`
   through the PM workflow endpoint, then does the work. If the reviewer
   divided the task into subtasks, the assignee (or parallel subagents)
   works each subtask and ticks it `Done` as it completes.
5. When implementation is complete, or when the assignee is waiting for
   reviewer/manager/reporter feedback or response, the assignee moves the
   task to `Review` through the PM workflow endpoint with one concise note
   explaining the result, blocker, or question. For code-touching tasks
   this immediately wakes the monitor agent to verify the repository
   before any reviewer is woken.
6. If the task was in `Review` only because the assignee was waiting for
   feedback or an external response, and that response arrives, the
   assignee resumes with workflow action `start`, completes the follow-up,
   then calls `ready_for_review` again with one concise note.
7. The resolved reviewer reviews the task **only after monitor validation
   (`pm.repo.verify.ok`) has passed** for code-touching tasks. If
   satisfied, the reviewer moves it to `Done`; otherwise they leave
   concrete feedback while the task stays in `Review`.
8. After `review_done`, PM assigns the next unassigned top-level `To Do`
   task in the same Open Epic to the completed task's assignee.
9. Assignees must always answer unresolved review feedback before taking
   a new `To Do` task. If no feedback is waiting, they should start the
   next assigned and approved `To Do` task while waiting for review on
   other work. If the next assigned task is not approved yet, they post
   its Action Plan and wait.

No agent should fake task completion. The workflow is considered complete
only when source-channel evidence exists: branch/commit/tests where code
changed, PM comments where feedback was addressed, and the correct PM
status transition.

Task and Epic comments are durable workflow evidence, not a stream of
thinking. Keep visible comments direct and consolidated: one comment per
turn should contain the current issues, blockers, findings, and required
questions whenever possible. Do not repeat a known blocker unless the
state changed or the current turn asks for an update.

When a human task comment explicitly asks an agent to create, update, or
reorganize PM work items, PM supplies the same single-use work-item
proposal grant used by Action Plan turns. Use the proposal endpoint from
the turn; do not write work-item rows directly. Agent comments and PM
workflow notifications do not grant that capability. Direct project-scoped
chats carry the same project proposal grant and short-lived PM context-read
grants. If the human message includes a same-project Task or Epic URL, use
the loopback grant URL in the turn to fetch that PM context; do not try to
open the public browser URL. Monitor-role agents may use grant-scoped PM
reads and proposals, but they are not valid assignee/reviewer/acting-manager
principals for normal implementation ownership. Straightforward
implementation tasks should not generate implementation debate in comments:
start the task, do the work, and leave one concise ready-for-review note
when there is evidence for the reviewer. Never post workflow-status
acknowledgements such as "task moved to Review" after calling a workflow
endpoint. If the endpoint action fully handled the turn, reply only with
the exact silent token and no other text.

**Enforcement paths:**

- Proposal application must wake affected agents after assignment, status,
  manager, or comment changes. The database row changing is not enough.
- Assigned `Backlog` work asks for an Action Plan message only. It does
  not authorize implementation or status changes.
- Assigned `To Do` work asks the assignee to post an Action Plan if
  `approved_on` is empty. Only approved `To Do` work can move to
  `In Progress`.
- Moving code-touching work to `Review` wakes the monitor agent first.
  The monitor rejects dirty worktrees, pushes clean local branch commits
  when it can, verifies the remote branch/prefix/git author and committer
  against the project git identity or global git identity fallback,
  rebuilds the live PM worktree if that branch is serving the website, and
  only then wakes the resolved reviewer. Non-code Review work can wake the
  reviewer directly.
- Waiting for reviewer/manager/reporter feedback is a `Review` state, not
  a stale `In Progress` state. The assignee should include one concise
  blocker/question/comment in the `ready_for_review` workflow call.
- `review_feedback` keeps the task in `Review` and wakes the assignee.
- `review_done` moves the task to `Done` and triggers the next-task Epic
  handoff when one exists.
- Approval-only reviewer comments are treated as a workflow error. The
  resolved reviewer must use `review_done`. PM also auto-completes a
  `Review` task when the resolved reviewer posts an **unmistakable
  approval comment** — the keyword is `looks good, ship it` — then
  assigns/wakes the next Epic task if one exists. Use `review_done` in
  preference; the keyword is a convenience fallback, not the normal path.
- Agent-authored comments should only wake other agents when they carry a
  specific workflow action: assignee plan/re-review, reviewer feedback,
  or an explicit mention. Routine agent status comments must not create a
  new round of agent discussion.
- PM-channel callback handling must be rate-limited so a wedged agent or
  stream cannot flood the web process.
- Async PM-channel jobs require a live worker drain path: either the
  in-process poller (`PM_CHANNEL_WORKER_POLL_MS`) or an external worker.

**Monitor-agent fallback:**

`ai-monitor` is the fallback when normal PM wake paths do not produce
action. It must read the same PM SQLite database as the active worktree.
On each host that database is the active PM worktree `DATABASE_URL`, for
example `file:/srv/Data/pm/wt-<branch>.db`.

The PM workflow probe detects: assigned `Backlog` tasks missing a
plan/opinion comment; assigned `To Do` tasks not moved to `In Progress`;
stale `In Progress` tasks; `Review` tasks waiting on the reviewer; review
feedback waiting on the assignee; reviewer/manager/reporter responses
waiting on the assignee while the task is in `Review`; active PM-channel
turns that never started or stopped producing output.

For `In Progress`, the stale timer uses the assignee's latest task comment
after the task entered `In Progress`. A real progress comment resets the
timer; silence after that still escalates. If the assignee is no longer
actively implementing because they need reviewer/manager/reporter input,
they must move the task to `Review` with one concise note instead of
leaving it in `In Progress`.

PM workflow drift is deterministic and bypasses monitor-agent judgment:

```text
T1 = native PM-channel nudge / wake
T2 = restart services and nudge again
T3 = final restart/nudge recovery attempt
T4 = Telegram only if the issue is still present after T3's confirmation window
```

`monitor_triage.escalation_ladder.max_attempts` controls the recovery
attempt count, and `pm_workflow.retry_after_tier3_seconds` controls when
PM workflow drift starts a new recovery cycle after a Telegram. A nudge or
Telegram does not resolve a PM workflow issue; only the PM probe no longer
emitting that issue resolves it.

Live monitor ticks must be single-instance locked. `--dry-run` and
`--probe-only` must not write monitor state, otherwise debugging can
accidentally suppress recovery or duplicate nudges.

**Replicating on a new AI server:**

- Keep host secrets and literal runtime users out of git.
- Copy the repo template `ai/openclaw/config/ai-monitor.config.json.example`
  to `/etc/ai-monitor/config.json` and fill host-specific values.
- Ensure `monitor_triage.auto_action_kinds_bypass_monitor` includes PM
  workflow kinds: `pm-backlog-plan-missing`, `pm-todo-not-started`,
  `pm-in-progress-stale`, `pm-review-feedback-awaiting-assignee`,
  `pm-review-awaiting-reviewer`, `pm-channel-no-start`, and
  `pm-channel-stalled`.
- Ensure the monitor can discover the active PM database from
  `/etc/default/pm-active-worktree` or `/etc/default/pm`.
- Install changed host helpers after deployment:

```bash
sudo -n install -m 0755 ai/openclaw/bin/ai-monitor /usr/local/bin/ai-monitor
sudo -n install -m 0755 ai/openclaw/bin/pm-workflow-nudge /usr/local/sbin/pm-workflow-nudge
```

- Verify the active DB before relying on alerts:

```bash
sudo -n /usr/local/bin/ai-monitor --probe-only
```

Confirm `pm_workflow.database_path` points at the active worktree database.

---

## Code and PR boundary

Code-hosting mechanics live in focused guides:
[`guides/BITBUCKET.md`](./guides/BITBUCKET.md) (branch, commit, push,
review, PR, Smart Commits) and [`guides/CODE_REPOS.md`](./guides/CODE_REPOS.md)
(shared `/srv/Code` checkout mechanics and `claim-branch`).

Fleet-wide invariant: agents do not create, update, approve, or merge
pull requests unless zeh explicitly changes that policy in the relevant
source-specific workflow. When code is ready, report the branch, commit,
tests, and residual risk in the source channel and wait for human action.

---

## Assignment and ownership

- Before any assignment, status, or workflow mutation, prove ownership or
  review duty from the source record and this file.
- Never self-assign implementation work.
- Unassigned implementation work is not automatically yours, even if it
  looks ready or arrives through a webhook.
- A coordinating agent may assign or hand off work only when the task is
  ready, not blocked, and the handoff is justified by the larger context.
- Any coding agent may start only after assignment by zeh, source-system
  rules, or a valid handoff.
- If a webhook/event says "assigned to me" but the actor is yourself,
  treat it as a policy error and do not start work.

---

## Task handoff

The coordinating agent provides:

- Goal.
- Work item / link / context.
- Role expected from the implementer.
- Files, services, or systems likely involved.
- Constraints and non-goals.
- Acceptance criteria.
- Required tests / builds / checks.
- Escalation triggers.

The receiving agent:

- Follows the plan closely; avoids broad refactors unless required.
- Asks or escalates when the plan conflicts with reality.
- Reports only **done** or **blocked**.
- Saves reusable lessons to memory.

---

## Reviewing

Reviewer checks:

- Does the result satisfy the work item / request?
- Are risky files / services touched?
- Are migrations, env vars, auth, permissions, and service restarts
  handled correctly?
- Were tests / builds / checks run?
- Is the completion comment accurate?
- Are secrets excluded from commits, logs, and memory?
- Is durable operational knowledge that should be saved actually saved?

For shared repository branch review mechanics, use
[`guides/BITBUCKET.md`](./guides/BITBUCKET.md) and
[`guides/CODE_REPOS.md`](./guides/CODE_REPOS.md).
A signed-off review **does not** authorise the reviewer, implementer, or
any other agent to create or merge a PR.

**Monitor validation first (code-touching tasks).** The resolved reviewer
reviews the task **only after** the monitor agent has verified the
repository (`pm.repo.verify.ok`). Moving a code-touching task to `Review`
wakes the monitor agent first; the monitor rejects dirty worktrees,
pushes clean local branch commits when it can, verifies the remote
branch/prefix/git author and committer against the project git identity
or global git identity fallback, rebuilds the live PM worktree if that
branch is serving the website, and only then wakes the resolved reviewer.
Non-code Review work can wake the reviewer directly. Do not approve or
`review_done` a code task before `pm.repo.verify.ok` is present.

Output: concise and findings-first. In Zero Latency / PM, if the review
is satisfied, move the task to `Done` through the workflow endpoint
(`review_done`) and do not post an approval-only comment. The keyword
`looks good, ship it` in an approval comment also triggers PM
auto-complete, but prefer the workflow endpoint. If a visible review
handoff is needed in another source channel, say no issues and mention
remaining risk. Sign the review handoff when the destination calls for the
signature rule.

---

## Email

- Ignore mail from yourself. Auto-act only on whitelisted senders. Send
  only to whitelisted recipients.
- In-scope mail: direct inbox from zeh / sibling agents, plus labels from
  approved work trackers, code hosts, document tools, or collaboration
  systems even when filters archived them.
- Mail from approved senders is actionable by default: the configured
  email whitelist plus every registered local agent with email access. If
  it asks for a plan, example, acknowledgement, check, decision, or
  implementation action, reply in the same email thread promptly. Do not
  wait for source-system assignment unless the email explicitly says to
  wait.
- **Read whole thread before acting.**
- After inspecting any in-scope email, **mark it read immediately** -
  use helpers that mark read automatically (`gmail-get-text.js`) or run
  `gmail-mark-read.js <messageId>` after fetching. Reading does not
  imply action; decide queue / reply / no-op separately.
- Email from zeh or a sibling agent is **actionable by default**. When
  an email asks for a reply or response-time test, send a concise reply
  promptly before longer work.
- A queued email task is complete only when the source email action is
  complete: reply/acknowledgement sent when requested, relevant helper
  output recorded in the progress log, and the `Status:` in
  `~/tasks/current.md` is no longer `QUEUED`.
- For email-originated tasks: send exactly one Telegram start notice
  after accepting; then communicate only in the email thread.
- Sibling-agent replies in an existing email task thread are actionable
  thread updates but **must not** create another Telegram start notice.
- Reply-all when all recipients are allowed; ask zeh first if reply-all
  would include a non-whitelisted recipient.
- Sign every email per the signature rule.

---

## Telegram

- Direct requests from zeh are actionable.
- If an approved Telegram sender asks for a finding, check, decision, or
  action, answer in Telegram unless redirected to another source channel.
  Do not convert the request into background work and go silent.
- **Start with the work**, not acknowledgement.
- Telegram is findings-only by default: answer with the result, risk,
  decision, or blocker that matters.
- Do **not** paste every terminal command, tool call, log tail, stack
  trace, or step-by-step execution transcript into Telegram. Mention
  commands only when zeh explicitly asks, when the exact command is the
  finding, or when the command is the next action zeh must run.
- If you investigated with commands, compress the output to the
  meaningful finding: what is broken, what changed, what you verified,
  and what remains.
- The only routine start notice is the single Telegram per source-channel
  or email task acceptance.
- Do **not** send Telegram progress, completion, or blocker messages for
  source-channel/email tasks after that one start notice - use the source
  channel.
- Ambiguous but low-risk: reasonable assumption, proceed. Possible
  external side effects: ask first.
- Keep replies short. Prefer one short paragraph or 2-4 bullets.
- **Never sign Telegram messages.** The signature rule is source-channel
  comments/email only.

---

## System / service operations

- Inspect current state before changing services.
- Back up config files before edits.
- Prefer minimal, reversible changes.
- Restart / reload services only when required.
- Verify service state and recent logs after restart.
- Record durable service changes in `MEMORY.md`.

---

## Maintaining `tasks/current.md`

`~/tasks/current.md` is your live queue, not a forever log. When an
entry reaches a terminal status (`DONE`, `RESOLVED`, `CLOSED`,
`CANCELLED`, `WONT_FIX`, `DUPLICATE_HANDLED`, `AUTO_RESOLVED`,
`ARCHIVED`, etc.), move it out - keep `current.md` short and current.

- **At completion**: when you flip an entry to a terminal status, in the
  same edit move the whole heading-block to `~/tasks/log.md` (append at
  the end). One operation: don't leave terminal entries sitting in
  `current.md` "for context".
- **Hygiene sweep**: on every fresh wake, scan `current.md` top-to-bottom
  and archive anything terminal you find. If an entry has no explicit
  `Status:` line, add one before deciding whether to archive.
- **Why this matters**: the agents dashboard surfaces your *current
  task* by reading the newest non-terminal entry in `current.md`. Stale
  completed entries make the dashboard lie about what you're working on
  and obscure real signal. Tools like `ai-monitor` also key off this
  file - give them an accurate view.
- **Do not delete** archived entries - `log.md` is the audit trail. Just
  move them.

---

## Knowledge handling

- Save durable facts that affect future behaviour.
- `MEMORY.md` for compact current facts; `memory/YYYY-MM-DD-topic.md`
  for task logs and longer discoveries.
- **No secrets** in memory, work items, chat, or comments.
- Update memory immediately when a fact changes role / models / auth /
  deployment / service ports / workflow.
- After a coordinated execution loop, the implementer saves reusable
  implementation lessons; the coordinating/reviewing agent saves review
  lessons if any.

---

## Escalation

**Escalate to another agent/reviewer** when:

- Architecture is unclear.
- Production, auth, data-loss, or security risk is involved.
- A second perspective from a different model would help - for example
  the current approach isn't converging, or you want a sanity check on a
  non-obvious decision before committing. Treat this as **getting another
  perspective**, not as a role hierarchy.
- A task crosses multiple systems or has ambiguous acceptance criteria.

**Escalate to zeh** when:

- External communication or public action is ambiguous.
- Credentials, billing, account access, or approvals are needed.
- The requested action conflicts with documented rules.
- The task cannot proceed safely.