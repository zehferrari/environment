# JIRA.md

Jira-specific workflow for the OpenClaw agent fleet. Use this together
with [`../WORKFLOW.md`](../WORKFLOW.md) (the single workflow authority),
[`./ROLES.md`](./ROLES.md), and [`./BITBUCKET.md`](./BITBUCKET.md) when
a task comes from Jira or an Atlassian notification.

If this file and `WORKFLOW.md` ever conflict, `WORKFLOW.md` wins.

## Quick index

| When you are about to... | Read |
|---|---|
| Send a Jira comment | [Jira comments](#jira-comments) |
| Respond to a Jira @-mention | [Jira @-mentions](#jira-mentions) |
| Choose the next Jira task | [Picking Jira work](#picking-jira-work) |
| Start an assigned issue | [Working a Jira ticket](#working-a-jira-ticket) |
| Assign or hand off an issue | [Jira assignment](#jira-assignment) |
| Push code for a Jira issue | [`./BITBUCKET.md`](./BITBUCKET.md) |

---

## Jira comments

- Follow [`../WORKFLOW.md` -> Sending an outbound](../WORKFLOW.md#sending-an-outbound)
  for markdown, body-passing, and signature rules.
- Jira comments are written with the Jira helpers (`jira-comment.js`
  converts markdown to Atlassian Document Format).
- Cite Jira issue keys, branch names, commit hashes, PR numbers, and file
  paths verbatim.
- End every Jira outbound with the mandatory signature:

```text
--
<First Name>
<provider>/<model>
```

---

## Jira @-mentions

If you're @-mentioned in a Jira comment, you **must** post a reply on
that ticket, even if the ticket is not assigned to you. Silence is not
an option. The webhook receiver will wake you with a prefix like:

```text
You were @-mentioned in <KEY> by <name>. ...
```

- **You can help**: do the work, reply with results, and sign per the
  signature rule.
- **Nothing useful to add**: post a brief acknowledgement saying why
  ("I've reviewed the prior comment and have nothing to add"), and tag
  the right person if redirection is needed.
- **Ticket is someone else's**: reply in the comment thread only. Do
  **not** transition the ticket or take it over without explicit handoff.
- **Backlog exception**: the reply is mandatory, but no action may be
  applied to a Backlog ticket (see
  [`../WORKFLOW.md` -> Receiving a mention](../WORKFLOW.md#receiving-a-mention)).
- If you do not reply within 15 minutes, `ai-monitor` fires
  `mention-awaiting-reply` warn; at 60 minutes or more it fires crit.

This rule supersedes the "only my tickets" default for the duration of
the @-mention thread.

---

## Picking Jira work

After completing a ticket, email, or Telegram task, pick the next Jira
task using the [fixed priority order in `WORKFLOW.md`](../WORKFLOW.md#picking-your-next-task).
Jira queue/status names:

0. **Explicit wake/system-event task.** As above.
1. **Unanswered feedback on your review-stage tickets.** A round is
   "unanswered" when the latest comment on a ticket in `In Review` /
   `Wait for Review` is from someone other than you, postdates your last
   comment, and postdates the most recent transition into review. Oldest
   comment first. Respond with **concrete action**.
2. **`Selected for Development` tickets assigned to you**, oldest
   `created` first. These are zeh-approved to start. Send the one allowed
   Telegram start notice, move to `In Progress`, and work in Jira.
3. **`To Do` tickets assigned to you by zeh directly.** If a sibling
   agent assigned without zeh's approval, leave it for zeh to triage.
   Otherwise post a one-line Jira intent comment, move to `In Progress`,
   and proceed.
4. **`Backlog`**: always skip (reply to mentions only, no action).
5. **Unassigned tickets**: do not claim them. If one looks important,
   report the finding in Jira or hand it to the manager / zeh for
   assignment.
6. **Nothing in tiers 1-3**: send `HEARTBEAT_OK` and stop. Do not poll
   Jira; the next webhook or email will wake you.

### Pressure-relief escape hatch

If three or more unanswered feedback rounds are queued and zero progress
has been made on `Selected for Development` for more than 24 hours, send
zeh **one** Telegram one-liner:

```text
<your-name>: review pressure starving build - N feedback rounds queued, M Selected for Development tickets idle >24h
```

Then continue feedback-first. Max one such Telegram per 24 hours per
agent.

---

## Working a Jira ticket

1. Read the full ticket: comments, attachments, linked issues,
   acceptance criteria, and current status. On Jira email/webhook wake-up,
   fetch the live issue before acting.
2. Jira keys are not WDT-only. Treat any `PROJECT-123` form as valid
   (`HOMELAB-3`, `WDT-47`, etc.).
3. If a Jira lookup says not found / no access but a webhook or email
   names the ticket, re-check with the workspace helpers before
   declaring no action. If lookups disagree, tell zeh you're blocked
   instead of saying the ticket does not exist.
4. Identify the role for the task (implementer / manager / reviewer /
   researcher / operator). Role is task-specific.
5. **`Backlog` -> ignore completely.** No queue, wake, comment,
   transition, or work, even if assigned or mentioned. Override only on
   explicit zeh instruction for that specific ticket.
6. If the ticket is unassigned, do not assign it to yourself and do not
   start implementation. A coordinating agent may assign it to another
   agent only when that handoff is justified by the Epic/task context.
7. Determine your Jira role from the live issue, not your persona or
   registry label. You may implement only when the issue is explicitly
   assigned to you by zeh or by a valid task handoff.
8. Send exactly **one** concise Telegram start notice to zeh after
   accepting an assigned ticket, then move it to `In Progress` before
   real work. After that, communicate about the task only in Jira unless
   zeh redirects.
9. If blocked, do not start unless explicitly instructed. If a blocker
   exists, wait until the blocker is `Done`/merged-to-main, not merely
   approved.
10. Use a ticket-key branch. Commit messages include the ticket key.
    For Bitbucket-backed repos under `/srv/Code/`, the target branch
    **must** be named in the Jira ticket; do not start without one. Full
    branch workflow: [`./BITBUCKET.md`](./BITBUCKET.md) and
    [`./CODE_REPOS.md`](./CODE_REPOS.md).
11. For risky / ambiguous / multi-step work needing approval, post a
    concise plan **before** implementation.
12. Run relevant tests/builds, or state plainly what could not be tested.
13. Push the branch. Do **not** create or update a pull request. PR
    creation is human-only.
14. **Do not create or merge a PR.** Creating and landing pull requests
    are exclusively human operator actions. No role, review verdict,
    elapsed time, or "looks fine" judgement authorises an agent to create
    or merge one. See [`./BITBUCKET.md`](./BITBUCKET.md) and
    [`../WORKFLOW.md` -> Code and PR boundary](../WORKFLOW.md#code-and-pr-boundary).
15. On completion, move the ticket to `Wait for Review` (or the project
    equivalent `In Review`). Post a concise completion comment with
    branch, commit, tests, and residual risk. Sign it.
16. Do **not** move tickets to `Done` unless explicitly instructed or the
    project workflow clearly assigns Done ownership to you.
17. When you flip the matching `~/tasks/current.md` entry to a terminal
    status, move it to `~/tasks/log.md` in the same edit. See
    [`../WORKFLOW.md` -> Maintaining tasks/current.md](../WORKFLOW.md#maintaining-taskscurrentmd).

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
- A coordinating agent may assign a ticket to another agent as an
  explicit handoff when the task is ready and not blocked.
- Any coding agent may start only after assignment by zeh or a valid
  handoff.
- If a webhook says "assigned to me" but the actor is yourself, treat it
  as a policy error and do not start work.

---

## Jira and code

Jira owns the issue lifecycle. Bitbucket owns branch/push/PR mechanics.

- Keep the Jira key in branch names and commit messages.
- Put completion evidence in Jira: branch, commit, tests, residual risk.
- Do not rely on commit side effects to communicate required status.
- Smart Commit details and local guardrails live in
  [`./BITBUCKET.md`](./BITBUCKET.md#smart-commits).