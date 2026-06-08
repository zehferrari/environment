# TEAM_WORKFLOW.md

The team's **playbook**, organised by action. Pick the row that matches
what you're about to do; jump to that section. You do not need to re-read
the whole file every session.

`AGENTS.md` is the boot manifest (always-on rules, operating baseline).
`ROLES.md` is the task-role manual. This file wins for any conflict on
**general process and task handling**.

Source-specific workflow lives in focused files:

- [`JIRA.md`](./JIRA.md) - Jira issue, comment, mention, status, and assignment rules.
- [`ZEROLATENCY.md`](./ZEROLATENCY.md) - Zero Latency / local PM task, chat, proposal, and status rules.
- [`BITBUCKET.md`](./BITBUCKET.md) - code-host branch, commit, push, review, PR, and Smart Commit rules.
- [`CODE_REPOS.md`](./CODE_REPOS.md) - shared `/srv/Code` checkout mechanics and `claim-branch`.

## Quick index

| When you are about to... | Read |
|---|---|
| Send an outbound source-channel comment or email | [Sending an outbound](#sending-an-outbound) |
| Receive a direct mention or addressed comment | [Receiving a mention](#receiving-a-mention) |
| Pick your next task after finishing one | [Picking your next task](#picking-your-next-task) |
| Start work on an assigned work item | [Working a tracked task](#working-a-tracked-task) plus the source-specific file |
| See unassigned work or want to assign work | [Assignment and ownership](#assignment-and-ownership) plus the source-specific file |
| Operate or debug Zero Latency workflow automation | [Zero Latency workflow enforcement](#zero-latency-workflow-enforcement) |
| Push code, prepare a branch, or think a PR is needed | [`BITBUCKET.md`](./BITBUCKET.md) and [Code and PR boundary](#code-and-pr-boundary) |
| Hand off work to another agent | [Task handoff](#task-handoff) |
| Review someone else's work | [Reviewing](#reviewing) |
| Handle email | [Email](#email) |
| Send a Telegram message | [Telegram](#telegram) |
| Touch a system or service | [System / service operations](#system--service-operations) |
| Close out a `tasks/current.md` entry | [Maintaining `tasks/current.md`](#maintaining-taskscurrentmd) |
| Save what you learned | [Knowledge handling](#knowledge-handling) |
| Escalate to another agent or to zeh | [Escalation](#escalation) |

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
source channel. Silence is not an option.

- **You can help**: do the work, reply with results, sign when the
  channel calls for the signature rule.
- **Nothing useful to add**: follow the source-specific rule. Zero
  Latency / PM uses a silent no-contribution path, so do not post a
  visible "nothing to add" comment there. Other channels may still
  require a brief acknowledgement and redirection.
- **Work belongs to someone else**: reply in the thread only. Do not
  transition, assign, or take over without explicit handoff.

This rule supersedes the "only my work items" default for the duration
of the mention thread. Source-specific mention routing and monitoring
SLA details live in [`JIRA.md`](./JIRA.md) and
[`ZEROLATENCY.md`](./ZEROLATENCY.md).

---

## Picking your next task

After completing a work item, email, or Telegram task, pick the next task
using this **fixed priority order**. Tier 1 must be exhausted before
tier 2 or 3.

0. **Explicit wake/system-event task.** If the current turn says to
   process a specific queued source-channel item, email, Telegram
   request, or `~/tasks/current.md` entry, do that first. The task is not
   complete until the requested source-channel reply/action is done and
   the task entry is updated out of `QUEUED`.
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

Use [`JIRA.md`](./JIRA.md) for Jira queue/status names and
[`ZEROLATENCY.md`](./ZEROLATENCY.md) for local PM queue/status names.

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

## Working a tracked task

1. Read the full source record before acting: description, comments,
   attachments, linked items, acceptance criteria, current status, and
   any dispatch/wake context.
2. Identify the role for the task (implementer / manager / reviewer /
   researcher / operator). Role is task-specific; do not infer it from
   persona alone.
3. If the source record is missing, inaccessible, or contradictory with
   the wake/email that named it, re-check using the source-specific
   helpers before declaring no action. If lookups disagree, tell zeh
   you're blocked.
4. Backlog/deferred work follows source-specific rules. In Zero Latency
   / PM, assigned Backlog work requires a plan/opinion comment but no
   status change or implementation until it reaches `To Do`.
5. If the work item is unassigned, do not assign it to yourself and do
   not start implementation.
6. You may implement only when the work is explicitly assigned to you by
   zeh, by a valid handoff, or by source-system rules that clearly grant
   you ownership.
7. Send exactly **one** concise Telegram start notice to zeh after
   accepting assigned source-channel work, then communicate about the
   task only in the source channel unless zeh redirects.
8. If blocked, do not start unless explicitly instructed. If a blocker
   exists, wait until the blocker is actually done/landed, not merely
   approved.
9. For risky, ambiguous, or multi-step work needing approval, post a
   concise plan **before** implementation.
10. For code work, follow the source-specific repo/code-host docs before
    creating branches, committing, pushing, or reporting review readiness.
    You MUST use git worktree under `/srv/Code/<repo>.worktrees/<branch>/`,
    work on the branch described in the task (which `claim-branch` cuts from
    `origin/master` or `origin/main` on origin if it doesn't exist), and
    ensure your git user name and email match the project settings
    (configuring locally via `git config --worktree` and writing to
    `expected-identity`). Refer to [`CODE_REPOS.md`](./CODE_REPOS.md) for details.
11. Run relevant tests/builds, or state plainly what could not be
    tested.
12. On completion, report the branch, commit, tests, and residual risk
    in the source channel. Sign the completion note when the channel
    calls for the signature rule.
13. Do not move work to a terminal/completed state unless explicitly
    instructed or the source-specific workflow clearly assigns that
    ownership to you.
14. When you flip the matching `~/tasks/current.md` entry to a terminal
    status, move it to `~/tasks/log.md` in the same edit - see
    [Maintaining `tasks/current.md`](#maintaining-taskscurrentmd).

---

## Assignment and ownership

- Before any assignment, status, or workflow mutation, prove ownership or
  review duty from the source record and source-specific workflow file.
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

## Zero Latency workflow enforcement

This section is the durable workflow contract formerly documented in the
`workflow-enforcement.txt` handoff. Use it with [`ZEROLATENCY.md`](./ZEROLATENCY.md)
when operating or debugging the local PM workflow.

### Manager / assignee / reviewer loop

1. A manager opens an Epic and orders the implementation tasks. Child
   task titles must start with `1.`, `2.`, `3.`, matching the intended
   implementation order.
2. Epic implementation tasks may be created only by the Epic acting
   manager, only after the Epic Action Plan is approved, and only when
   the Epic has no existing child tasks. Additional work inside a Task is
   tracked as task-local subtasks, not new Epic tasks.
3. The manager moves the ordered tasks to `To Do`.
4. The manager assigns only the first executable task.
5. The assignee posts one concrete technical plan in the task's Action
   Plan tab before implementation.
6. The reviewer or reporter reviews the Action Plan in the Action Plan
   tab. If it needs adjustment, they reply there with one consolidated
   feedback comment. If it is acceptable, they approve it with a concise
   approval note explaining why the plan is acceptable or naming any
   constraints; approval stamps `approved_on` and `approved_by`.
   When a Task Action Plan has an explicit `Deliverables`,
   `Implementation steps`, `Checklist`, `Subtasks`, or `Milestones`
   section and the Task has no subtasks yet, PM creates those entries as
   ordered task-local subtasks so progress can be tracked against the
   approved plan. Do not treat bullets under `Inputs`, `Rule logic`,
   context, risks, or open questions as subtasks.
   Subtasks may be created only by the task assignee, only after the Task
   Action Plan is approved, and only when the Task has no existing child
   subtasks.
7. The assignee starts that approved task by moving it to `In Progress`
   through the PM workflow endpoint, then does the work.
8. When implementation is complete, or when the assignee is waiting for
   reviewer/manager/reporter feedback or response, the assignee moves the
   task to `Review` through the PM workflow endpoint with one concise
   note explaining the result, blocker, or question. For code-touching
   tasks this immediately wakes the monitor agent to verify the repository
   before any reviewer is woken.
9. If the task was in `Review` only because the assignee was waiting for
   feedback or an external response, and that response arrives, the
   assignee resumes with workflow action `start`, completes the follow-up,
   then calls `ready_for_review` again with one concise note.
10. The resolved reviewer reviews the task only after monitor validation
   (`pm.repo.verify.ok`) has passed. If satisfied, the reviewer moves it
   to `Done`; otherwise they leave concrete feedback while the task stays
   in `Review`.
11. After `review_done`, PM assigns the next unassigned top-level `To Do`
   task in the same Open Epic to the completed task's assignee. Task-local
   subtasks are checklist/progress rows and must not be used as the next
   Epic implementation task.
12. Assignees must always answer unresolved review feedback before taking
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
workflow notifications do not grant that capability.
Direct project-scoped chats carry the same project proposal grant and
short-lived PM context-read grants. If the human message includes a
same-project Task or Epic URL, use the loopback grant URL in the turn to
fetch that PM context; do not try to open the public browser URL.
Monitor-role agents may use grant-scoped PM reads and proposals, but they
are not valid assignee/reviewer/acting-manager principals for normal
implementation ownership.
Straightforward implementation tasks should not generate implementation
debate in comments: start the task, do the work, and leave one concise
ready-for-review note when there is evidence for the reviewer.
Never post workflow-status acknowledgements such as "task moved to
Review" after calling a workflow endpoint. If the endpoint action fully
handled the turn, reply only with the exact silent token and no other
text.

### Enforcement paths

- Proposal application must wake affected agents after assignment,
  status, manager, or comment changes. The database row changing is not
  enough.
- Assigned `Backlog` work asks for an Action Plan message only. It does
  not authorize implementation or status changes.
- Assigned `To Do` work asks the assignee to post an Action Plan if
  `approved_on` is empty. Only approved `To Do` work can move to
  `In Progress`.
- Moving code-touching work to `Review` wakes the monitor agent first. The
  monitor rejects dirty worktrees, pushes clean local branch commits when it
  can, verifies the remote branch/prefix/git author and committer against the
  project git identity or global git identity fallback, rebuilds the live PM
  worktree if that branch is serving the website, and only then wakes the
  resolved reviewer. Non-code Review work can wake the reviewer directly.
- Waiting for reviewer/manager/reporter feedback is a `Review` state,
  not a stale `In Progress` state. The assignee should include one
  concise blocker/question/comment in the `ready_for_review` workflow
  call.
- `review_feedback` keeps the task in `Review` and wakes the assignee.
- `review_done` moves the task to `Done` and triggers the next-task Epic
  handoff when one exists.
- Approval-only reviewer comments are treated as a workflow error. The
  resolved reviewer must use `review_done`; PM also auto-completes a
  `Review` task when the resolved reviewer posts an unmistakable approval
  comment, then assigns/wakes the next Epic task if one exists.
- Agent-authored comments should only wake other agents when they carry a
  specific workflow action: assignee plan/re-review, reviewer feedback,
  or an explicit mention. Routine agent status comments must not create a
  new round of agent discussion.
- PM-channel callback handling must be rate-limited so a wedged agent or
  stream cannot flood the web process.
- Async PM-channel jobs require a live worker drain path: either the
  in-process poller (`PM_CHANNEL_WORKER_POLL_MS`) or an external worker.

### Monitor-agent fallback

`ai-monitor` is the fallback when normal PM wake paths do not produce
action. It must read the same PM SQLite database as the active worktree.
On each host that database is the active PM worktree `DATABASE_URL`, for example:

```text
file:/srv/Data/pm/wt-<branch>.db
```

The PM workflow probe detects:

- assigned `Backlog` tasks missing a plan/opinion comment;
- assigned `To Do` tasks not moved to `In Progress`;
- stale `In Progress` tasks;
- `Review` tasks waiting on the reviewer;
- review feedback waiting on the assignee;
- reviewer/manager/reporter responses waiting on the assignee while the
  task is in `Review`;
- active PM-channel turns that never started or stopped producing output.

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

### Replicating on a new AI server

- Keep host secrets and literal runtime users out of git.
- Copy the repo template
  `ai/openclaw/config/ai-monitor.config.json.example` to
  `/etc/ai-monitor/config.json` and fill host-specific values.
- Ensure `monitor_triage.auto_action_kinds_bypass_monitor` includes PM
  workflow kinds:
  `pm-backlog-plan-missing`, `pm-todo-not-started`,
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

Code-hosting mechanics are intentionally not duplicated in this shared
playbook. Before touching a shared repository, read the source-specific
code-host file and the shared checkout mechanics:
[`BITBUCKET.md`](./BITBUCKET.md) and [`CODE_REPOS.md`](./CODE_REPOS.md).

Fleet-wide invariant: agents do not create, update, approve, or merge
pull requests unless zeh explicitly changes that policy in the relevant
source-specific workflow. When code is ready, report the branch, commit,
tests, and residual risk in the source channel and wait for human action.

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

For shared repository branch review mechanics, use the source-specific
code-host file and [`CODE_REPOS.md`](./CODE_REPOS.md).
A signed-off review **does not** authorise the reviewer, implementer, or
any other agent to create or merge a PR.

Output: concise and findings-first. In Zero Latency / PM, if the review
is satisfied, move the task to `Done` through the workflow endpoint and
do not post an approval-only comment. If a visible review handoff is
needed in another source channel, say no issues and mention remaining
risk. Sign the review handoff when the destination calls for the
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
