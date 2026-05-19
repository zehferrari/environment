# TEAM_WORKFLOW.md

The team's **playbook**, organised by action. Pick the row that matches
what you're about to do; jump to that section. You do not need to re-read
the whole file every session.

`AGENTS.md` is the boot manifest (always-on rules, operating baseline).
`ROLES.md` is the task-role manual. This file wins for any conflict on
**process and task handling**.

## Quick index

| When you are about to… | Read |
|---|---|
| Send a Jira comment or email | [Sending an outbound](#sending-an-outbound) |
| Receive an @-mention on Jira | [Receiving an @-mention](#receiving-an-mention) |
| Pick your next task after finishing one | [Picking your next task](#picking-your-next-task) |
| Start work on an assigned Jira ticket | [Working a Jira ticket](#working-a-jira-ticket) |
| See an unassigned Jira ticket or want to assign one | [Jira assignment](#jira-assignment) |
| Push code or think a PR is needed | [Code and PR boundary](#code-and-pr-boundary) |
| Hand off work to another agent | [Task handoff](#task-handoff) |
| Review someone else's work | [Reviewing](#reviewing) |
| Handle email | [Email](#email) |
| Send a Telegram message | [Telegram](#telegram) |
| Touch a system or service | [System / service operations](#system--service-operations) |
| Save what you learned | [Knowledge handling](#knowledge-handling) |
| Escalate to another agent or to zeh | [Escalation](#escalation) |

---

## Sending an outbound

Applies to **Jira comments, status updates, completion notes, email
replies, and review handoffs**. Does **not** apply to Telegram (see
[Telegram](#telegram)).

### Format

Reply content must be **proper markdown**. The helpers (`jira-comment.js`
→ ADF; `gmail-send.js` → multipart HTML) translate it for you, but only
if you actually write markdown:

- Separate paragraphs with blank lines (single newlines stay inside one
  paragraph).
- Bullet (`- `) or numbered (`1. `) lists for findings, steps, options.
- ATX headings (`## Section`) when the reply has multiple sections.
- Fenced code blocks (```` ``` ````) for code/config/log; inline `code`
  for filenames, identifiers, commands, env vars.
- Pipe tables for comparisons or summaries.
- Cite Jira keys, PR numbers, and file paths verbatim.

Discord/WhatsApp consume different formatting — no markdown tables,
Discord links wrapped in `<>`, WhatsApp uses **bold**/CAPS instead of
headings.

### Signature (mandatory)

End every Jira/email outbound with this signature on its own paragraph:

```text
--
<First Name>
<provider>/<model>
```

- Two hyphens, exactly.
- **First name only** — the first token of your `name` field in
  `agents.json`. Not the full display name.
- `<provider>/<model>` plain, no `Model:` prefix. Use the **actual**
  current runtime model, not a remembered default. If unclear:
  `openclaw sessions --active 10 --json`.

`jira-comment.js` and `mime.js` render the provider/model line subdued
(smaller, grey). You write plain text; helpers do the styling.

Mandatory even for short / urgent / acknowledgement messages.
**Forbidden** in Telegram.

---

## Receiving an @-mention

If you're @-mentioned in a Jira comment, you **must** post a reply on
that ticket — even if the ticket isn't assigned to you. **Silence is not
an option.**

- **You can help** → do the work, reply with results, sign per the
  signature rule.
- **Nothing useful to add** → post a brief acknowledgement saying why
  ("I've reviewed the prior comment and have nothing to add"), and tag
  the right person if redirection is needed.
- **Ticket is someone else's** → reply in the comment thread only. Do
  **not** transition the ticket or take it over without explicit
  handoff.

This rule supersedes the "only my tickets" default for the duration of
the @-mention thread. The webhook receiver will wake you with a prefix
"`You were @-mentioned in <KEY> by <name>. …`" — that's your cue.

If you don't reply within 15 min, ai-monitor fires
`mention-awaiting-reply` warn; ≥60 min → crit.

---

## Picking your next task

After completing a ticket, email, or Telegram task, pick the next using
this **fixed priority order**. Tier 1 must be exhausted before tier 2 or
3.

0. **Explicit wake/system-event task.** If the current turn says to process
   a specific queued email, Telegram request, Jira mention/ticket, or
   `~/tasks/current.md` entry, do that first. The task is not complete until
   the requested source-channel reply/action is done and the task entry is
   updated out of `QUEUED`.
1. **Unanswered feedback on your review-stage tickets.** A round is
   "unanswered" when the latest comment on a ticket in `In Review` /
   `Wait for Review` is from someone other than you, postdates your last
   comment, AND postdates the most recent transition into review. Oldest
   comment first. Respond with **concrete action** (code change pushed,
   plan revised, question answered) — not just acknowledgement.
2. **`Selected for Development` tickets assigned to you**, oldest
   `created` first. zeh-approved to start. Send the one allowed Telegram
   start notice, move to `In Progress`, work in the source channel.
3. **`To Do` tickets assigned to you by zeh directly.** If a sibling
   agent assigned without zeh's approval, leave it for zeh to triage.
   Otherwise post a one-line Jira intent comment, move to `In Progress`,
   proceed.
4. **`Backlog`** → always skip.
5. **Unassigned tickets** → do not claim them. If one looks important,
   report the finding in the source channel or hand it to the manager /
   zeh for assignment.
6. **Nothing in tiers 1–3** → send `HEARTBEAT_OK` and stop. Don't poll
   Jira; the next webhook or email will wake you.

### Pressure-relief escape hatch

If ≥3 unanswered feedback rounds queued AND zero progress on `Selected
for Development` for &gt;24 h, send zeh **one** Telegram one-liner:
`<your-name>: review pressure starving build — N feedback rounds
queued, M Selected for Development tickets idle &gt;24h`. Then continue
feedback-first. Max one such Telegram per 24 h per agent.

---

## Working a Jira ticket

1. Read the full ticket — comments, attachments, linked issues,
   acceptance criteria, current status. On Jira email/webhook wake-up,
   fetch the live issue before acting.
2. Jira keys are not WDT-only. Treat any `PROJECT-123` form as valid
   (`HOMELAB-3`, `WDT-47`, etc.).
3. If a Jira lookup says not found / no access but a webhook or email
   names the ticket, re-check with the workspace helpers before
   declaring no action. If lookups disagree, tell zeh you're blocked
   instead of saying the ticket doesn't exist.
4. Identify the role for the task (implementer / manager / reviewer /
   researcher / operator). Role is task-specific.
5. **`Backlog` → ignore completely.** No queue, wake, comment,
   transition, or work — even if assigned or mentioned. Override only on
   explicit zeh instruction for that specific ticket.
6. If the ticket is unassigned, do not assign it to yourself and do not
   start implementation. A coordinating agent may assign it to another
   agent only when that handoff is justified by the Epic/task context.
7. Determine your Jira role from the live issue, not your persona or
   registry label. You may implement only when the issue is explicitly
   assigned to you by zeh or by a valid task handoff.
8. Send exactly **one** concise Telegram start notice to zeh after
   accepting an assigned ticket, then move it to `In Progress` before
   real work. After that, communicate about the task only in Jira
   unless zeh redirects.
9. If blocked, don't start unless explicitly instructed. If a blocker
   exists, wait until the blocker is `Done`/merged-to-main, not merely
   approved.
10. Use a ticket-key branch. Commit messages include the ticket key.
   For repos under `/srv/Code/`: the target Bitbucket branch **must**
   be named in the ticket — do not start without one. Attach a
   worktree on that branch with `claim-branch <repo> <branch>` and
   work inside the path it prints (never edit the primary `/srv/Code/<repo>/`
   tree directly). Full workflow in [`CODE_REPOS.md`](./CODE_REPOS.md).
11. For risky / ambiguous / multi-step work needing approval, post a
   concise plan **before** implementation.
12. Run relevant tests/builds, or state plainly what couldn't be tested.
13. Push the branch. Do **not** create or update a pull request. PR creation
    is human-only.
14. **Do not create or merge a PR.** Creating and landing pull requests are
    exclusively human operator actions — no role, no review verdict, no time
    elapsed, no "looks fine" justifies an agent creating or merging one. See
    [`CODE_REPOS.md` → Pull requests](./CODE_REPOS.md#pull-requests--humans-only).
15. On completion, move the ticket to `Wait for Review` (or the project
    equivalent `In Review`). Post a concise completion comment with branch,
    commit, tests, and residual risk. Sign it.
16. Do **not** move tickets to `Done` unless explicitly instructed or
    the project workflow clearly assigns Done ownership to you.

---

## Jira assignment

- Before any Jira mutation, run this preflight:
  - Is it an Epic?
  - Am I assigned to the Epic?
  - Is this a child of an Epic I am assigned to manage?
  - Is this task assigned to me by zeh or a valid agent handoff?
  - Is it Backlog?
  - If none of those prove ownership or review duty: no mutation and no work.
- Never assign a Jira ticket to yourself.
- Unassigned implementation tickets are not automatically yours, even if
  they are `Selected for Development` or arrive through a webhook.
- A coordinating agent may assign a ticket to another agent as an explicit
  handoff when the task is ready and not blocked.
- Any coding agent may start only after assignment by zeh or a valid handoff.
- If a webhook says "assigned to me" but the actor is yourself, treat it
  as a policy error and do not start work.

---

## Code and PR boundary

- Code work happens under `/srv/Code` worktrees only, through
  `claim-branch`, unless zeh explicitly says otherwise.
- Commits under `/srv/Code` must be authored as
  `Zeh Ferrari <e@zeh.me>`.
- Agents may push their ticket branch.
- Agents must not create pull requests, update pull request metadata, approve
  pull requests, or merge pull requests. When a branch is ready, report the
  branch, commit, tests, and residual risk in Jira/email and wait for zeh.

---

## Task handoff

The coordinating agent provides:

- Goal.
- Ticket / link / context.
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

For shared repos under `/srv/Code/`, attach a worktree on the branch
under review — sequential after the implementer releases theirs
(`claim-branch <repo> <branch>`), or concurrent in detached-HEAD mode
while the implementer is still iterating (`claim-branch <repo> <branch> --review`).
Release with `claim-branch --release <repo> <branch> [--review]` when done.
Full flow in [`CODE_REPOS.md`](./CODE_REPOS.md).

A signed-off review **does not** authorise the reviewer (or anyone else) to
create or merge a PR. Approving means "this branch is ready for zeh to turn
into a PR and land" — not "go create or land it". See
[`CODE_REPOS.md` → Pull requests](./CODE_REPOS.md#pull-requests--humans-only).

Reviewer checks:

- Does the result satisfy the ticket / request?
- Are risky files / services touched?
- Are migrations, env vars, auth, permissions, and service restarts
  handled correctly?
- Were tests / builds / checks run?
- Is the completion comment accurate?
- Are secrets excluded from commits, logs, and memory?
- Is durable operational knowledge that should be saved actually saved?

Output: concise and findings-first. If no issues, say so and mention
remaining risk. Sign the review handoff.

---

## Email

- Ignore mail from yourself. Auto-act only on whitelisted senders. Send
  only to whitelisted recipients.
- In-scope mail: direct inbox from zeh / sibling agents, plus Jira /
  Atlassian / Bitbucket / Confluence labels (even when filters archived
  them).
- Mail from approved senders is actionable by default: the configured email
  whitelist plus every registered local agent with email access. If it asks
  for a plan, example, acknowledgement, check, decision, or implementation
  action, reply in the same email thread promptly. Do not wait for Jira
  assignment unless the email explicitly says to wait.
- **Read whole thread before acting.**
- After inspecting any in-scope email, **mark it read immediately** —
  use helpers that mark read automatically (`gmail-get-text.js`) or run
  `gmail-mark-read.js <messageId>` after fetching. Reading does not
  imply action; decide queue / reply / no-op separately.
- Email from zeh or a sibling agent is **actionable by default**. When
  an email asks for a reply or response-time test, send a concise reply
  promptly before longer work.
- A queued email task is complete only when the source email action is
  complete: reply/acknowledgement sent when requested, relevant helper output
  recorded in the progress log, and the `Status:` in `~/tasks/current.md` is
  no longer `QUEUED`.
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
  action, answer in Telegram unless redirected to email/Jira. Do not convert
  the request into background work and go silent.
- **Start with the work**, not acknowledgement.
- Telegram is findings-only by default: answer with the result, risk,
  decision, or blocker that matters.
- Do **not** paste every terminal command, tool call, log tail, stack trace,
  or step-by-step execution transcript into Telegram. Mention commands only
  when zeh explicitly asks, when the exact command is the finding, or when
  the command is the next action zeh must run.
- If you investigated with commands, compress the output to the meaningful
  finding: what is broken, what changed, what you verified, and what remains.
- The only routine start notice is the single Telegram per Jira / email
  task acceptance.
- Do **not** send Telegram progress, completion, or blocker messages
  for Jira/email tasks after that one start notice — use the source
  channel.
- Ambiguous but low-risk → reasonable assumption, proceed. Possible
  external side effects → ask first.
- Keep replies short. Prefer one short paragraph or 2-4 bullets.
- **Never sign Telegram messages.** The signature rule is Jira/email
  only.

---

## System / service operations

- Inspect current state before changing services.
- Back up config files before edits.
- Prefer minimal, reversible changes.
- Restart / reload services only when required.
- Verify service state and recent logs after restart.
- Record durable service changes in `MEMORY.md`.

---

## Knowledge handling

- Save durable facts that affect future behaviour.
- `MEMORY.md` for compact current facts; `memory/YYYY-MM-DD-topic.md`
  for task logs and longer discoveries.
- **No secrets** in memory, tickets, chat, or comments.
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
- A second perspective from a different model would help — for example
  the current approach isn't converging, or you want a sanity check on a
  non-obvious decision before committing. Treat this as **getting another
  perspective**, not as a role hierarchy.
- A task crosses multiple systems or has ambiguous acceptance criteria.

**Escalate to zeh** when:

- External communication or public action is ambiguous.
- Credentials, billing, account access, or approvals are needed.
- The requested action conflicts with documented rules.
- The task cannot proceed safely.
