# Workflow invariants (ENV-116)

Executable specifications for the **PM Workflow Improvement** Epic. They were
written *before* any behaviour change so each Epic item has an objective,
regression-sensitive acceptance gate rather than a subjective "looks fixed".

Nothing here changes runtime behaviour. There is no migration, no edit to
`lib/workflow.ts`, and no new write path. The monitor surface is read-only.

## Where things live

| File | Role |
| --- | --- |
| `lib/workflow-invariants.ts` | The registry. Pure predicates over plain record shapes — **no Prisma import**. Also exports the disposition enum, the workflow-action classification table, the lease TTL, and the baseline comparator. |
| `lib/workflow-invariants-db.ts` | Read-only live-DB adapter: loads a snapshot and evaluates it. `checkWorkflowInvariants()` lives here so the registry stays database-free. |
| `lib/workflow-invariants-baseline.json` | The expected-fail baseline (see below). |
| `scripts/workflow-invariants-test.ts` | `pnpm test:workflow-invariants` — fixture unit tests, no database. |
| `scripts/workflow-invariants-db-test.ts` | `pnpm test:workflow-invariants-db` — real rows on a throwaway sqlite, matched against the baseline. |
| `scripts/workflow-invariants-monitor.ts` | `pnpm workflow-invariants-monitor` — read-only Monitor Agent surface. |

## Core definitions

**Lease.** New `PmChannelRun` rows carry `leaseExpiresAt` and `heartbeatAt`.
Renewal is explicit and terminal/superseded rows relinquish the lane. The
invariant adapter conservatively derives a deadline from the most recent proof
of life only for legacy rows that predate the lease columns.

**Disposition.** A closed enum — `continue`, `waiting_external`,
`ready_for_review`, `completed`, `failed` — plus a classification of every action
the workflow endpoint accepts:

- *continuation-required* (a step **inside** an episode): `start`, `add_subtask`,
  `complete_subtask`, `remove_subtask`, `clear_blocker`, `publish_checkpoint`
- *episode-terminal* (control handed back): `ready_for_review`, `submit_review`,
  `review_feedback`, `review_done`, `triage_to_todo`, `approve_plan`,
  `assign_task`, `request_subtask`, `request_task`, `flag_blocker`,
  `flag_extra_work_blocker`

The classification table is asserted complete against the endpoint's own `ACTIONS`
list, so adding an action without classifying it fails the suite.

## The invariants

| Id | Scope | Epic item | Statement | Baseline |
| --- | --- | --- | --- | --- |
| WFI-001 | run-lifecycle | 2 | At most one genuinely active run per (task-or-epic, agent) lane. | **passes** |
| WFI-002 | run-lifecycle | 2 | A non-terminal run must have renewed its lease within the TTL, or have been settled terminal. | red |
| WFI-003 | run-lifecycle | 2 | An In Progress task must not rest its "work is happening" evidence on a lease-expired, never-superseded run. | red |
| WFI-004 | turn-disposition | 1 | A continuation-required action must not be what settles a run as a successful terminal outcome. | **passes** (ENV-118) |
| WFI-005 | turn-disposition | 3 | Every terminal run must carry an explicit disposition from the closed enum. | **passes** (ENV-118) |
| WFI-006 | turn-disposition | 3 | A run may not be complete with an empty final response and no workflow action standing in for it. | red |
| WFI-007 | blocker | 6 | Every active formal blocker must name an external actor and a concrete actionable requirement, as structured data. | **passes** (ENV-120) |
| WFI-008 | action-plan | 4 | An approved plan on an assigned task must yield a durable checklist from structured steps, never scraped Markdown. | **passes** (workflow hardening) |

WFI-001 already holds. WFI-004 and WFI-005 were closed by ENV-118, and WFI-007
by ENV-120. WFI-008 is closed by structured ActionPlanStep provenance. Do not
add baseline entries for any of these invariants.

## The expected-fail baseline

Three of the eight invariants are still **red on purpose**. They describe the Epic's
target state, not today's. Rather than land a broken suite or water the
invariants down, the known-violated set is recorded in
`lib/workflow-invariants-baseline.json` and the suite is green while observed ==
expected, **code for code and count for count**.

Three drift kinds fail the suite:

- `regression` — a violation code that is not in the baseline
- `count_mismatch` — a baselined code firing a different number of times
- `unrecorded_pass` — a baselined code that no longer fires

That last one is the important one: an Epic item must delete its baseline entry
in the **same commit** that makes the invariant pass, so "fixed" and "recorded as
fixed" can never drift apart.

Counts are pinned to the canonical scenario seeded by
`scripts/workflow-invariants-db-test.ts` — deterministic, unlike a live database.
That scenario uses the production writers wherever one exists
(`recordPmChannelRunQueued`, `recordPmChannelRunWorkflowAction`,
`createActionPlanSubtasksForTask`), so the red results are real behaviour, not a
hand-written strawman.

The closed Epic's aggregate gate is `pnpm test:workflow`. It includes the
invariant suites, action-effect coverage, transition/outbox coverage, watchdog
and episode tests, repository workflow, whole-Epic acceptance, blocker/plan
tests, and the full regression family.

## Deterministic blockers (ENV-120)

WFI-007 is closed by making the blocker claim *checkable*. `flag_blocker` no
longer accepts prose alone: it requires a `blockerReport`
(`lib/tasks/formal-blocker.ts`) and runs it through two pure functions before
the task may enter a human-blocked state.

`validateFormalBlockerReport` checks shape — `blockedOn` from the closed enum,
plus a non-empty `requestedActor`, `requestedAction`, `evidence`,
`diagnosticsAttempted[]` and a concrete `resumeCondition`.
`classifyBlockerFailure` then decides what the claim actually is:

| Outcome | When | What PM does |
| --- | --- | --- |
| `accept` | a human class (`person`/`permission`/`decision`), or a technical class that has earned escalation | raise the formal blocker; persist the report on the `task.blocker` row |
| `reject` | malformed report, or `requestedActor` resolves to the assignee | `422` naming the rule that fired; no run action is recorded, so the episode continues |
| `incident` | a recoverable `external_service`/`dependency` failure | write `task.blocker.incident`; task stays In Progress, nobody is woken, the agent retries |

Escalation out of the incident state is a bounded policy over **distinct
diagnostic evidence**, never elapsed time or a retry counter: the report needs
at least `FORMAL_BLOCKER_MIN_DISTINCT_DIAGNOSES` distinct diagnoses *and* at
least `FORMAL_BLOCKER_MIN_PRIOR_INCIDENTS` earlier incident round for the same
failure signature carrying a different diagnosis. Diagnoses are compared
case- and trailing-punctuation-insensitively, so restating one attempt cannot
buy a promotion.

The other half is the grant path (`lib/tasks/blocker-permission-grant.ts`). One
click commits four effects in one transaction: record the grant, clear the round
it answers, supersede every competing active run for that (task, agent), and
reserve exactly one authorization-linked continuation. Deterministic activity
ids make it idempotent — a double click collides and rolls back. The
`publish_checkpoint` kind is the deliberate exception to "clear on grant": its
single-use authorization must stay resolvable from the *active* blocker while
the runner consumes it, so that round is closed by its own settlement
(`lib/tasks/checkpoint-blocker.ts`).

Suites: `pnpm test:formal-blocker-validation` (pure rules) and
`pnpm test:blocker-permission-grant` (grant atomicity and idempotency).

## Action effects and the continuation outbox (ENV-118)

ENV-116's binary classification is the spec; `lib/agents/workflow/action-effect.ts`
is the runtime, and it **derives** its table from `WORKFLOW_ACTION_CLASS` so the
two can never disagree. It adds one distinction the runtime needs:

| Effect | Actions | What happens to the run |
| --- | --- | --- |
| `continue` | every `continuation-required` action | lease renewed, run and job left **unsettled**, a continuation armed |
| `wait` | `flag_blocker`, `flag_extra_work_blocker`, `request_subtask`, `request_task` | settled `complete`, disposition `waiting_external` |
| `finish` | every other `episode-terminal` action (task and epic routes) | settled `complete`, disposition `ready_for_review` or `completed` |

Both terminal effects record `settledByAction`; `continue` deliberately does not,
because nothing was settled.

`PmChannelContinuation` is the outbox. The arm write shares the transaction with
the run/job write, so a crash between "start task" and "queue the next turn"
cannot lose the continuation. When the turn actually ends (`final`/`done`) with a
row still `armed`, the run settles with disposition `continue` and the row becomes
`queued`; `drainPmChannelContinuations` (run from the PM channel worker drain)
turns it into a fresh execution turn. An episode-terminal action, a cancel, or a
terminal failure supersedes it instead.

The reply-time heuristic in `lib/agents/workflow/execution-continuation.ts` stands
down whenever the outbox owns the turn, so the two paths cannot both enqueue and
break WFI-001.

## Durable workflow sources

The runtime no longer reconstructs current workflow state from a long comment
thread:

- `Task.workflowVersion` plus immutable `WorkflowTransition` rows are the task
  status ledger. Every active browser, agent, proposal and Epic-cascade path
  crosses `lib/tasks/transition-kernel.ts`.
- `WorkflowOutbox` is the source of truth for repository jobs, reviewer and
  assignee wake-ups, finalization, cleanup and board projection. A transition
  and all effects commit together.
- The final child Task's Done transition outboxes whole-Epic candidate
  preparation in that same transaction. Completion approval likewise outboxes
  immutable-candidate re-verification, and verified Epic Done outboxes cleanup;
  none of those obligations depends on an in-memory post-commit callback.
- `ActionPlan`, `ActionPlanRevision` and `ActionPlanStep` are the approved-plan
  source. Implementation `SubTask` rows point back to their plan step, so
  checklist provenance is mechanical rather than parsed from Markdown.
- `ReviewRun` locks one immutable candidate SHA. Reviewer acceptance and
  finalization are valid only for that exact candidate.
- `PmChannelRun.disposition`, `settledByAction`, completion evidence and
  `PmChannelContinuation` carry execution state. Legacy rows may still use the
  conservative ActivityLog adapter, but new writes do not.

WFI-006 still correctly reports a run that ends with disposition `continue`
without a durable reply. That is interrupted execution; the continuation and
watchdog make it recoverable, but do not mislabel it complete.

## Boundary drift guard

`pnpm test:workflow-boundary` parses every TypeScript source under `app/` and
`lib/` and fails if a route writes `Task.status` directly. The only allowlisted
owner is `lib/tasks/transition-kernel.ts`. This turns “remember to use the
kernel” from review advice into a build-time constraint.

## Monitor usage

```
pnpm workflow-invariants-monitor                 # human summary, exit 0
pnpm workflow-invariants-monitor --json          # machine-readable report
pnpm workflow-invariants-monitor --strict        # exit 1 if any violation
pnpm workflow-invariants-monitor --since-days=3  # narrow the run window
pnpm workflow-invariants-monitor --project=<id>  # one project only
```

Every query in the adapter is a `findMany`/`findFirst`/`count`. The db test
asserts row counts are unchanged across a `checkWorkflowInvariants()` call, so
the read-only guarantee is enforced, not just documented.

## Adding an invariant

1. Append a `WorkflowInvariant` to `WORKFLOW_INVARIANTS` with the next `WFI-NNN`
   id, a statement, a scope, its Epic item, and a pure predicate.
2. Give each violation a stable `code` of the form `WFI-NNN/kebab-reason` — the
   baseline matches on codes, never on cuids.
3. Add a positive and a negative fixture case in
   `scripts/workflow-invariants-test.ts`.
4. If current behaviour violates it, seed the shape in the db test's canonical
   scenario and record the exact counts in the baseline. If it already holds,
   record nothing.
5. Update the table above.
