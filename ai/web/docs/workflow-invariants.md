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

## Two definitions the schema had no primitive for

**Lease.** `PmChannelRun` has no lease column. A run's lease is derived: the most
recent proof of life (`lastEventAt`, else `streamingAt`, else `acceptedAt`, else
`createdAt`) plus `WORKFLOW_RUN_LEASE_TTL_MS` (30 minutes, aligned with
`PM_CHANNEL_JOB_ACCEPTED_TIMEOUT_MS`). "Renew or become terminal" is expressed
against that, so the invariants are testable without a migration.

**Disposition.** A closed enum — `continue`, `waiting_external`,
`ready_for_review`, `completed`, `failed` — plus a classification of every action
the workflow endpoint accepts:

- *continuation-required* (a step **inside** an episode): `start`, `add_subtask`,
  `complete_subtask`, `remove_subtask`, `clear_blocker`, `publish_checkpoint`
- *episode-terminal* (control handed back): `ready_for_review`, `submit_review`,
  `review_feedback`, `review_done`, `triage_to_todo`, `approve_plan`,
  `assign_after_plan_approval`, `request_subtask`, `request_task`, `flag_blocker`,
  `flag_extra_work_blocker`

The classification table is asserted complete against the endpoint's own `ACTIONS`
list, so adding an action without classifying it fails the suite.

## The invariants

| Id | Scope | Epic item | Statement | Baseline |
| --- | --- | --- | --- | --- |
| WFI-001 | run-lifecycle | 2 | At most one genuinely active run per (task-or-epic, agent) lane. | **passes** |
| WFI-002 | run-lifecycle | 2 | A non-terminal run must have renewed its lease within the TTL, or have been settled terminal. | red |
| WFI-003 | run-lifecycle | 2 | An In Progress task must not rest its "work is happening" evidence on a lease-expired, never-superseded run. | red |
| WFI-004 | turn-disposition | 1 | A continuation-required action must not be what settles a run as a successful terminal outcome. | red |
| WFI-005 | turn-disposition | 3 | Every terminal run must carry an explicit disposition from the closed enum. | red |
| WFI-006 | turn-disposition | 3 | A run may not be complete with an empty final response and no workflow action standing in for it. | red |
| WFI-007 | blocker | 6 | Every active formal blocker must name an external actor and a concrete actionable requirement, as structured data. | red |
| WFI-008 | action-plan | 4 | An approved plan on an assigned task must yield a durable checklist from structured steps, never scraped Markdown. | red |

WFI-001 already holds. Do not add a baseline entry for it.

## The expected-fail baseline

Seven of the eight invariants are **red on purpose**. They describe the Epic's
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

Neither new script is wired into an aggregate test target; run them explicitly
until the Epic closes.

## Known derivation gaps

Three snapshot fields have no column yet, and the live adapter is deliberately
conservative about them. The gaps *are* the Epic work:

- **`settledByAction`** is recoverable only for actions that write an
  `ActivityLog` row carrying the action name (`task.move`, blocker raise/clear,
  action-plan approval). `add_subtask`, `complete_subtask` and `remove_subtask`
  settle a run with no durable trace at all, so they read back as `null` and
  WFI-004 cannot see them. **Epic item 1 must persist the settling action on the
  run** — that also widens WFI-004's live coverage.
- **`finalResponseText`** is reconstructed from the reply/silent `ActivityLog`
  row PM writes per turn, then the referenced chat message or comment body.
- **`disposition`** is recorded nowhere. Always `null`, which is why WFI-005 is
  red by construction until **Epic item 3** lands.
- **Checklist provenance** is not stored either. The only automated producer
  today is the Markdown scraper in `lib/tasks/action-plan-subtasks.ts`, so a
  populated checklist is classified `markdown-prose`. **Epic item 4** should
  record structured plan steps and their provenance.

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
