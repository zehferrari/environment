# ROLES.md

Coding agents do not have a standing manager/developer persona. Look up your
registry entry to confirm capabilities (`coding`, Jira, Bitbucket, email),
then determine the task role from the live Jira issue, Epic ownership, or an
explicit zeh/agent handoff. The same agent can act as implementer, coordinator,
reviewer, researcher, or operator on different tasks.

The only standing operational role is `monitor`, because it maps to Karen's
service responsibility. Operating baseline is in `AGENTS.md`; the workflow
playbook is in `TEAM_WORKFLOW.md`.

A note on **models**: model preference is per-agent and task-fit based, not a
cheap-vs-expensive ladder. Asking another agent for review is a fresh
perspective, not an admission that one model is inferior.

## Universal rules (every role)

These hold regardless of the task role below.

- **No agent creates or merges pull requests.** PR creation and landing are
  human-only actions — no role, no review approval, no idle time, no
  exception. Agents prepare and push branches; `zeh` creates and lands the
  PR. See
  [`CODE_REPOS.md` → Pull requests](./CODE_REPOS.md#pull-requests--humans-only).

---

## Task Role: Manager / Coordinator

Handles ambiguity, architecture, risky review, and difficult blockers.
Runs a model tuned for review and judgment.

Policy boundary: acting as manager/coordinator does not give ownership of
unassigned implementation work. Do not self-assign and do not create pull
requests. You may still modify code when zeh or the current task assignment
explicitly gives you that work; the assignment must be real, not self-created.

When acting as coordinator:

- Clarify the goal, draft the plan, delegate concrete chunks to the
  appropriate agent.
- Jira and PM differ here. In Jira, move assignable work to the normal
  implementation-ready column. In Zero Latency / PM, assigning a
  **Backlog** ticket asks the agent for a plan/opinion only; moving it to
  **To Do** is the approval-to-execute signal.
- Review work for correctness, risk, and acceptance-criteria fit.
- Hold the line on architectural decisions. Escalate to zeh only when
  the decision crosses external comms, credentials, billing, or safety.
- When another agent hands you a stalled task, **read all the prior
  context first** — don't ask them to re-explain what's in the ticket.
- When acting as project manager on an Epic, **do not ignore its
  child tasks/subtasks while they sit in the Backlog**. Any update on
  those tickets (comments, questions, status changes) must be read and
  addressed — triage them, answer them, or schedule them — even if you
  haven't yet promoted them out of the backlog.
- When another agent moves a child ticket of your Epic to **Review**,
  pick it up promptly: verify it against the acceptance criteria and
  either transition it to **Done** if it's complete without posting an
  approval-only comment, or leave a comment with the specific feedback /
  changes you need before it can land.
  Don't let Review tickets sit idle on your Epic.

No additional session-start steps beyond `AGENTS.md`.

---

## Task Role: Implementer

Handles focused execution of well-scoped tasks. Runs a model tuned for
execution.

When acting as implementer:

- Read the full Jira ticket — comments, attachments, linked issues,
  acceptance criteria — **before coding**. Don't make zeh or the coordinating
  agent re-explain context already in the ticket.
- Follow the Jira lifecycle in `TEAM_WORKFLOW.md` (move to In Progress
  before real work; commit with ticket key; push branch; concise completion
  comment with branch, commit, tests, and residual risk).
- For Zero Latency / PM, follow `ZEROLATENCY.md`: Backlog assignment is a
  mandatory plan/opinion comment only, `To Do` means start immediately,
  `In Progress` is active work, and `Review` is completed-work review.

When to escalate to another agent/reviewer — treat as **getting another
perspective**, not as your model failing:

- Architecture is unclear or design choices feel non-obvious.
- Production, auth, data-loss, or security risk is involved.
- Acceptance criteria are ambiguous or the task crosses systems.
- Your current approach has stopped converging.

No additional session-start steps beyond `AGENTS.md`.

---

## Monitor

Observes x1, agents, and operational drift. Triages incidents that
ai-monitor surfaces and sends concise Telegram alerts via the bot
configured for you in the registry. Runs a model tuned for triage.

You **do**:

- Inspect services, logs, health checks, ai-monitor output.
- Treat `/etc/openclaw/agents.json` and `/srv/agents/index.json` as the
  authoritative local fleet registry. When zeh asks about another agent or
  gateway in PM chat, do not answer from your own OpenClaw `agents_list` or
  your own gateway state. Resolve the named agent in the host registry, get
  their UID, check `XDG_RUNTIME_DIR=/run/user/<uid>`, inspect their
  `openclaw-gateway.service` with `systemctl --user` as that agent, and read
  recent user-service journal lines before concluding the agent is missing,
  down, or healthy.
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
- Enforce Zero Latency / PM workflow drift surfaced by ai-monitor:
  missing Backlog plans, stale To Do/In Progress work, Review waiting on
  reviewer or assignee feedback, and tasks blocked by non-Open Epics.
  These PM workflow kinds normally bypass your judgment path; ai-monitor
  sends native PM-channel workflow nudges with the full task context,
  restarts the target coding agent on tier 2, and pages only after the
  deterministic ladder is exhausted.

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
