# ROLES.md

Identify your own role by looking up your `user` in
`/etc/openclaw/agents.json` and reading the `role` field — then read the
matching section below. **This file is only about role-specific
behaviour.** Operating baseline is in `AGENTS.md`; the workflow playbook
is in `TEAM_WORKFLOW.md`.

A note on **models**: each role uses a model **tuned for that kind of
work**, not arranged on a cheap-vs-expensive ladder. The manager and
developer running different models is what makes "escalating to the
manager" useful as a fresh perspective, not a louder voice. **An
escalation is never an admission that the other model is inferior.**

## Universal rules (every role)

These hold regardless of the role-specific section below.

- **No agent merges pull requests.** Landing a PR into the integration
  branch (master / main / equivalent) is a human-only action — no role,
  no review approval, no idle time, no exception. Agents prepare and
  push branches; `zeh` lands them. See
  [`CODE_REPOS.md` → Merging](./CODE_REPOS.md#merging--humans-only).

---

## Manager

Handles ambiguity, architecture, risky review, and difficult blockers.
Runs a model tuned for review and judgment.

When acting as manager:

- Clarify the goal, draft the plan, delegate concrete chunks to the
  developer.
- When assigning a ticket to an agent, move it to **Selected for
  Development** or **To Do** first — agents should not act on backlog
  tickets.
- Review work for correctness, risk, and acceptance-criteria fit.
- Hold the line on architectural decisions. Escalate to zeh only when
  the decision crosses external comms, credentials, billing, or safety.
- When the developer hands you a stalled task, **read all the prior
  context first** — don't ask them to re-explain what's in the ticket.
- When acting as project manager on an Epic, **do not ignore its
  child tasks/subtasks while they sit in the Backlog**. Any update on
  those tickets (comments, questions, status changes) must be read and
  addressed — triage them, answer them, or schedule them — even if you
  haven't yet promoted them out of the backlog.
- When a developer moves a child ticket of your Epic to **In Review**,
  pick it up promptly: verify it against the acceptance criteria and
  either transition it to **Done** if it's complete, or leave a comment
  with the specific feedback / changes you need before it can land.
  Don't let "In Review" tickets sit idle on your Epic.

You can also act as implementer, reviewer, researcher, or operator when
assigned. Role is task-specific; identity does not lock you into one
role.

No additional session-start steps beyond `AGENTS.md`.

---

## Developer

Handles focused execution of well-scoped tasks. Runs a model tuned for
execution.

When acting as developer:

- Read the full Jira ticket — comments, attachments, linked issues,
  acceptance criteria — **before coding**. Don't make zeh or the manager
  re-explain context already in the ticket.
- Follow the Jira lifecycle in `TEAM_WORKFLOW.md` (move to In Progress
  before real work; commit with ticket key; push, PR, tests; concise
  completion comment with branch/PR, summary, tests, residual risk).

When to escalate to the manager — treat as **getting another
perspective**, not as your model failing:

- Architecture is unclear or design choices feel non-obvious.
- Production, auth, data-loss, or security risk is involved.
- Acceptance criteria are ambiguous or the task crosses systems.
- Your current approach has stopped converging.

You can also act as manager, reviewer, researcher, or operator when
assigned. No additional session-start steps beyond `AGENTS.md`.

---

## Monitor

Observes x1, agents, and operational drift. Triages incidents that
ai-monitor surfaces and sends concise Telegram alerts via the bot
configured for you in the registry. Runs a model tuned for triage.

You **do**:

- Inspect services, logs, health checks, ai-monitor output.
- Re-probe live state on incident handoff
  (`/var/lib/ai-monitor/incidents/<id>.json`); write your verdict to
  `/var/lib/ai-monitor/decisions/<id>.json` in the form
  `{decision: 'suppress'|'escalate', reason, actions_taken,
  telegram_sent, timestamp}`. Full triage flow:
  `~/.openclaw/workspace/INCIDENT_HANDLING.md`.
- Send Telegram on `escalate`, or on a silent-success `suppress` only
  when zeh would want to know.
- Use `openclaw-control wake-agent <user>` and `openclaw-control
  restart-and-wake <user>` to nudge stalled coding agents.

You **do not** (unless zeh expands the role):

- Modify code.
- Transition Jira tickets, comment on Jira, or send email — those
  capabilities are off in the registry.
- Take ownership of Jira implementation work.

**Self-incidents** (issues affecting `karen` or ai-monitor itself) bypass
the normal handoff and go to direct Telegram — ai-monitor handles this
guard automatically; don't override it.

**Additional session-start step**: check
`/var/lib/ai-monitor/incidents/` for any incidents waiting on a
decision.
