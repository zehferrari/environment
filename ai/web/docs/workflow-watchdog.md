# The workflow watchdog (ENV-123)

`lib/workflow-invariants.ts` (ENV-116) can tell you a task is broken. It is a
**specification**: read-only, deliberately inert, and it repairs nothing. This
is the other half — the thing that notices, fixes what is safely fixable, and
then says so somewhere an operator can read without opening the comment history.

The Epic item this closes:

> Operators should no longer need to infer execution state from comments.

That sentence is the acceptance test. Everything below exists to make one
durable row per task honest enough to trust.

## Shape

```
lib/agents/watchdog/
  detectors.ts    pure predicates — what is broken (no Prisma, no clock, no writes)
  repairs.ts      one repair per detector, plus the circuit breaker
  run.ts          the live-DB pass: load → detect → repair → write state
  transitions.ts  keeps the state current on ORDINARY workflow actions
  state.ts        the TaskExecutionState store and the shared renderer
```

The detector/adapter split is the same discipline ENV-116 uses, and for the same
reason: predicates that take plain record shapes are testable from a fixture with
no database at all (`scripts/workflow-watchdog-test.ts`), while the live binding
is proved separately against real rows (`scripts/workflow-watchdog-db-test.ts`).

## The eight failure modes

| Detector | Fires when | Repair | Priority |
| --- | --- | --- | --- |
| `assigned_todo_plan_missing` | assigned To Do task has no durable structured Action Plan after the grace window | request `submit_plan` once | 65 |
| `expired_lease` | a run is `queued`/`accepted`/`streaming` but its lease is dead | settle it `timed_out` | 80 |
| `in_progress_no_active_run` | In Progress + assigned, nothing live, nothing scheduled | queue one continuation | 60 |
| `started_no_work` | last durable action is continuation-required, nothing followed | queue one continuation | 55 |
| `open_checklist_no_continuation` | open implementation checklist, nothing scheduled | queue one continuation | 50 |
| `blocker_permission_already_granted` | blocker still parked, its grant already landed | wake the assignee | 70 |
| `blocker_clear_loop` | ≥3 flag→clear cycles in 6h | **escalate only** | 100 |
| `session_churn` | current In Progress assignee lane is idle beyond the grace window after ≥4 distinct sessions or ≥3 failed/timed-out runs in 1h | **escalate only** | 95 |

The last two deliberately have **no automated repair**. A task that keeps
re-raising a blocker, or keeps burning sessions, is one where more automated
recovery *is* the problem. Those set the reporter flag and stop. Session churn
is scoped to runs created after the current In Progress state began; planning
and reviewer sessions do not count, and a live assignee run or armed
continuation is progress rather than a stall.

Priority resolves the common case where one task trips several detectors: every
finding's repair still runs (deduped per `task × repair × run`, so one pass can
never queue two continuations for one task), but the **highest-priority finding
is the one the operator sees**. `blocker_permission_already_granted` outranking
`in_progress_no_active_run` is the point — "no active run" is true but useless
when the actual diagnosis is "it is waiting for something that already arrived".

## Recovery goes through the outbox, never a direct dispatch

`queueRecoveryContinuation` arms an ENV-118 `PmChannelContinuation` row with
action `watchdog_recovery` and lets `drainPmChannelContinuations` schedule the
turn. That is not indirection for its own sake:

- the drain's preconditions (still In Progress, still the assignee, no competing
  run, no external blocker) protect watchdog recoveries for free;
- the row is durable, so a crash between "decide to recover" and "enqueue the
  turn" loses nothing;
- `@@unique([runId, messageId, action])` makes re-arming a renewal rather than a
  second turn.

The watchdog runs *before* the drain in `runPmChannelWorkerDrain`, for the same
reason the ENV-121 episode seal does: a continuation queued in this pass goes out
in this pass, not the next one.

The continuation drain gives `watchdog_recovery` its own wake text. The default
text names the action the agent took; a watchdog recovery fires precisely because
the agent took none, so saying "your turn recorded `watchdog_recovery`" would
name an action nobody performed.

## The circuit breaker

A repair that does not stick is a diagnosis, not something to retry forever.

- Budget: `PM_WATCHDOG_MAX_RECOVERIES` recoveries per task per rolling hour
  (default 3).
- Only the repairs that **can** loop consume it — `queue_continuation` and
  `wake_assignee`. Escalation is what happens *instead* of a recovery, and
  settling an expired lease is a once-per-run terminal write that cannot repeat;
  charging either would let noise trip the breaker protecting the recoveries
  that matter.
- On exhaustion the breaker opens for the rest of the window, the task reads
  `stalled`, `alertReporter` is raised, and a `task.watchdog.escalated`
  ActivityLog row records which detector gave up. `escalatedAt` makes that
  exactly-once, and it is cleared when the task looks healthy again so a later
  loop escalates afresh instead of staying silent.

## What the operator sees

One `TaskExecutionState` row per task, rendered identically by the task detail
strip, the board badge and the agent context packet — all through
`renderExecutionState`, so the three cannot drift:

```
Execution: stalled
Reason: no active run
Last durable action: started at 09:24
Recovery: new run queued
```

Two properties make it trustworthy rather than decorative:

1. **It is written on ordinary transitions too**, not only on watchdog passes
   (`transitions.ts`, called from the workflow route). A strip that lags a real
   `ready_for_review` by a drain interval teaches operators to distrust it, and a
   distrusted strip sends them straight back to reading comments.
2. **The write is a no-op when nothing observable moved.** The watchdog runs on
   every worker drain; a row whose `updatedAt` churns every few seconds is
   indistinguishable from one that is genuinely changing. `writeTaskExecutionState`
   compares first and returns `false` rather than writing, and `recoveryAt` is
   preserved (not restamped) when a repair is merely re-observed.

A task the watchdog has never evaluated has **no row**, and the UI renders
nothing. Inventing `idle` for it would be the guessing this work removes.

## Usage

```
pnpm workflow-watchdog --dry-run        # detect and print, change nothing
pnpm workflow-watchdog                  # detect and repair
pnpm workflow-watchdog --json           # machine-readable report
pnpm workflow-watchdog --project=<id>   # one project only
pnpm workflow-watchdog --strict         # exit 1 if anything is stalled
```

`--dry-run` is the one to reach for first: it exercises the whole pass and prints
exactly what would be repaired, without writing an outbox row or settling a run.

## Cross-layer reconciliation and workflow doctor

The execution watchdog covers model turns and continuations. A separate pass,
`lib/tasks/workflow-reconciler.ts`, checks the boundary between the committed
workflow ledger and asynchronous projections:

- queued effects that stopped draining and expired dispatcher leases;
- `validating` or `finalizing` repository phases whose recorded effect was
  delivered but never advanced downstream state;
- repository phases with no durable effect at all;
- Review tasks missing an active immutable `ReviewRun` lease;
- stale Review tasks whose `ReviewRun` was accepted and whose repository run
  completed after the exact candidate was verified on the Epic branch, but
  whose audited Review-to-Done transition is missing;
- Done tasks whose repository lifecycle is not `completed`;
- superseded gateway processes whose cancellation was never acknowledged.

Safe repair means requeueing the **existing** effect payload, retrying the
**existing** cancellation fence, or finishing an accepted review only when the
durable `ReviewRun`, repository candidate/reviewed SHA, valid completed
repository state, and matching `pm.epic.merge.ok` audit evidence all agree.
That completion uses the normal transition kernel, next-task assignment, Epic
roll-forward, notifications, and idempotency guards; it is not a raw board
status override. The reconciler never guesses a transition, candidate SHA or
command from comments. Missing evidence and exhausted effects raise
`alertReporter`, write `TaskExecutionState=stalled`, and create one idempotent
audit event. The PM worker runs reconciliation immediately before the generic
outbox drain, so a repaired effect is dispatched in the same pass.

The operator command is read-only unless `--apply` is explicit:

```
pnpm workflow-doctor                    # inspect, metrics + findings, no writes
pnpm workflow-doctor --json             # machine-readable health snapshot
pnpm workflow-doctor --project=<id>     # scope one project
pnpm workflow-doctor --since=<ISO>      # window counters, stop evidence + findings; splits out historical residue
pnpm workflow-doctor --apply            # bounded safe repairs + escalation
pnpm workflow-doctor --strict           # exit 1 when in-window findings exist
pnpm workflow-doctor --strict --since=<ISO>   # rollout gate: pre-window residue does not fail the run
```

`--since` windows event counters and event-backed Phase E stop conditions from
the supplied rollout timestamp. It does not hide current aggregate invariant
violations, active procedures, ownership distribution, or other live safety
state. JSON output reports older counters separately as
`phaseE.historicalResidueBeforeWindow`, so old evidence remains auditable
without failing a clean new observation window. Use the timestamp from the
successful `pm-switch` deployment receipt rather than an approximate shell
start time.

Its metrics report outbox counts by status, repository counts by phase,
execution-state counts and unacknowledged cancellation count. These are the
same records the worker reconciles, not comment-derived estimates.

## Tests

```
pnpm test:workflow-watchdog             # fixture: all eight detectors, no DB
pnpm test:workflow-watchdog-db          # throwaway sqlite: repairs, breaker, idempotency
pnpm test:workflow-watchdog-visibility  # the rendered surfaces
pnpm test:workflow-reconciler           # stale projection repair + escalation idempotency
pnpm test:workflow-boundary             # no direct Task.status route writes
```

The db suite's load-bearing assertions are the boring ones: a second pass queues
no second continuation, does not re-settle a settled run, does not burn more
budget, escalates exactly once, and — once the fleet is quiescent — writes no
state rows at all.

## Relationship to the invariants

ENV-116 reports; ENV-123 repairs. The watchdog closes no baseline entry in
`lib/workflow-invariants-baseline.json` and is not supposed to: the baseline
records what a *seeded canonical scenario* produces, and repairing live rows at
runtime does not change that scenario. What the watchdog does guarantee is that
WFI-002 and WFI-003 violations (`lease-not-renewed`,
`stale-active-run-without-successor`) stop *accumulating* in production, because
each one is settled on the next drain.

## Adding a detector

1. Append a `WatchdogDetector` to `WATCHDOG_DETECTORS` with a stable id, a
   one-line statement, and a pure predicate. Reuse the lease/action helpers from
   `lib/workflow-invariants.ts` rather than re-deriving them.
2. Choose a priority relative to the table above — it decides which diagnosis the
   operator reads when several fire on one task.
3. Give it exactly one `WatchdogRepairKind`, or `escalate` if automated recovery
   would be the wrong answer. Ask honestly which it is.
4. Add a positive and a negative fixture case, and a db case if the repair
   touches rows.
5. Update the table above.
