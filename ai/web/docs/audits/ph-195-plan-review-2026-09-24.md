# PH-195 plan review, checklist progress and stalled badges — 2026-09-24

## Observed failure

Task `cmues2f5h47loovbyrokcwz8p` (PH-195, Patricia) remained in Backlog
with draft Action Plan revision 1. Barekbaal submitted the structured plan;
Asdrubal was the assigned reviewer and had `approve_plan` and
`request_plan_changes` in its authenticated runtime. Its review turn
`1d719d62-35c9-44dc-a8da-9e18ad3a8840` returned only `NO_REPLY`, with no tool
calls or workflow decision. PM recorded successful transport completion.
There was no evidence of an approval-permission rejection.

The source had three gaps: review notifications carried no required-outcome
metadata; the plan-outcome check was inside a lifecycle branch that excludes
all terminal events; and the planning watchdog only recognized failed run
statuses, missing completed transport with a failed workflow outcome.
The model's reason for choosing silence is not observable from the transcript.

## Repair

Review notifications bind their required decision to the submitted plan ID
and version. Compact turns explicitly require approval, accepted review when
another actor owns approval, or consolidated change requests. An authenticated
workflow remains actionable when the submitting agent is its sender.

Terminal callbacks check the durable outcome after settling the run, including
silent finals and canonical terminal events. A missing review decision records
an anomaly and queues one durable recovery per plan revision and reviewer.
Repeated empty decisions alert the reporter and are visible to the watchdog.
Transport success is retained separately from workflow failure.

Recovery preserves the submitted plan and approval policy. It checks current
assignment, plan revision, prior decisions and newer runs. The outbox checks
revision and reviewer again before delivery. Ordinary context-only silence and
reviews accepted while awaiting owner approval do not trigger recovery.

The plan-review repair needs no schema or gateway-plugin update. Deployment uses the existing
`pm-switch` build/restart boundary. When serving this feature worktree against
the operational database, explicitly select
`PM_BRANCH_DB=/srv/Data/pm/wt-main.db`; a default feature-worktree switch would
select a separate database. Keep a consistent backup before the live switch.

Already dispatched review turns can be checked with `flagMissingTaskPlanOutcome`
using their exact stored reply target. The compatibility path recognizes the
existing `action_plan_review_requested` reason; the ordinary outbox delivers the
bounded recovery only while that review remains pending. PH-195 subsequently
advanced through owner approval to Review, so it no longer needs that recovery.
Do not reset the task or resubmit its plan.

## Regression coverage

`pnpm test:plan-review-outcome` exercises actual notifications, terminal
callbacks, SQLite persistence and outbox delivery in a disposable database:
agent-authored handoff, silent and prose-only completion, callback replay,
one-retry limit, legacy payloads, owner-approval waits, stale revisions,
reassignment and newer-run fencing. It is included in `pnpm test:workflow`.
The planning suite also verifies that completed transport with a missing
workflow outcome is detected as stalled.

## Incremental checklist completion

The task subsequently advanced after owner approval. Read-only audit inspection
found all five implementation items completed between 00:45:47.640 and
00:45:47.859 UTC on September 24, immediately before review submission.
The legacy notification prompt and shared workflow already require immediate
updates, but compact `pm-task/4` replaced that prompt without carrying the rule.
The assignee used the compact scoped-HTTP transport across its execution episodes.

The compact operating contract now requires `complete_subtask` with item-specific
evidence as soon as that item's implementation and acceptance checks finish,
before unrelated work or checkpointing. Separate verification and owner checks
remain pending until performed. The native tool description and scoped-HTTP
schema expose the same timing expectation. Checkpoint guidance distinguishes
recording progress from ticking checklist rows and respects episode fences.

Regression coverage verifies the instruction survives both native and HTTP
prompt generation. The authenticated workflow API test completes one item while
another remains pending, checkpoints without ticking the pending item, then
completes it using the same turn while preserving the first completion timestamp.
No automatic checkbox inference or timing-based refusal is introduced: the
runtime cannot determine that an implementation is finished from elapsed time.

The updated native tool description requires staging the PM channel plugin
and restarting gateways during a later authorized rollout. The compact runtime
and HTTP schema changes load with PM; no installation is performed here.

Deployment was initially deferred at the operator's request. The initial
change performed no live workflow recovery. The operator subsequently merged
`fix/plan-review-handoff`; merged main `b8d121d8` and the gateway tool description
were deployed, and the local feature worktree was removed before this follow-up.

## False stalled board badges

The board displays `TaskExecutionState.state`; it does not infer stalled status
from the age of the card or the most recent comment. The watchdog and workflow
reconciler write that state. Review tasks and formal external blockers have
separate waiting/blocked states, and Done cards do not display the badge.

Read-only inspection of PH-195 found a `stale_receipt_without_transition`
reconciliation alarm for its successful `submit_plan` receipt. Same-state
commands intentionally commit their domain writes and receipt without creating
a board transition or advancing the workflow version. The reconciler incorrectly
required a transition for every successful receipt and could overwrite `running`
with `stalled` until the watchdog corrected it again. It now checks the receipt's
expected and resulting versions; actual version advances without a transition
still raise an alarm. Plan submissions, checkpoints and checklist updates no
longer trigger this false diagnosis.

The watchdog also omitted authoritative heartbeat and lease-expiry columns from
its snapshot. It now uses both, retaining the established fallback for legacy
rows. Current runs and open continuations are loaded separately from bounded
recent history, so old completed rows cannot crowd out active work and a run
older than the history window remains visible. Archived tasks are excluded.
A real expired lease still produces a stalled state.

Changed execution-state writes publish the board refresh event and invalidate
the task shell after persistence. Identical observations remain no-ops. In-process
SSE subscribers refresh immediately through the existing debounce; out-of-process
writes rely on the existing visible-board polling fallback. Recovery clears the
stalled reason, detector and obsolete recovery description on the next watchdog
pass. These changes require the later authorized PM rollout; no live state was
rewritten during this investigation.

Regression coverage uses disposable SQLite databases for same-state receipts,
a current run older than the history window, a deliberately tiny history cap,
fresh heartbeats and leases, actual lease expiry, queued continuations after
closed history, and board notifications when the stalled badge turns on/off.

## Reopened-plan handoff follow-up

At 01:08:52 UTC, Barekbaal requested a revision of the approved plan's s5
verification requirements because PH-158/PH-152 tests were unavailable on the
current base. Reopening correctly cleared approval, closed execution cycle
`cmuetz5bn4iejovbycusxd109`, preserved work and returned PH-195 to To Do.
The assignee notification `cmueu2xy24j3vovbyayneu04i` retained that cycle ID,
so delivery skipped it as `workflow_cycle_superseded`. No revised plan was
submitted. Subsequent reviewer notifications could not advance a plan still
marked `revision_required`, and missing-plan recovery ignored existing plans.

Revision notifications now carry the exact plan ID/version. Delivery rechecks
that the same assignee still owns an unapproved, revision-required plan in
Backlog/To Do before allowing this handoff across the closed execution cycle.
Ordinary cycle fencing remains intact. The watchdog detects missing revisions
and queues one durable recovery per revision and assignee. It preserves the
plan, approval boundary and prior work, suppresses recovery during active work,
and prevents stale reviewer wakes until the revised draft has been submitted.

The active-plan regression now drains the actual cycle-closing outbox effect,
checks the assignee's planning capability, submits revision 2 through the
orchestrator, and observes its reviewer handoff. It also checks delivery replay,
bounded recovery, assignment/version/approval/archive fences and preservation
of completed evidence and owner acceptance requirements.

The operator authorized this follow-up directly on `main`, a rebuild and an
assignee wake. `pm-switch --database=main main` deployed the tested local changes
at 01:47:13 UTC with the operational database and no pending migrations.
Receipt: `2026-09-24T014713Z-main-b8d121d8338c.receipt` (9 dirty paths; this
follow-up remains uncommitted). Backup:
`/srv/Data/pm/backups/wt-main-before-revision-handoff-20260924T014425Z.db`.
Public login and a hashed CSS asset returned 200; both PM services were active.
The startup watchdog delivered recovery `cmuevg7x50006ovlxb8614ce4` to Barekbaal,
run `db79d7f4-3580-4b3f-b11d-5d88cba36899`, with `submit_plan` capability.
The explicit recovery check returned a no-op because that turn was already
active; the run reached streaming and recorded tool activity. No plan approval
or checklist completion was manufactured by the recovery.

## Validation

- Full combined workflow gate: 71/71 suites passed.
- TypeScript (`tsc --noEmit --incremental false`) passed.
- ESLint passed for the changed JavaScript and TypeScript files.
- `git diff --check` passed. The production revision handoff reached active
  assignee execution; the agent's eventual revised-plan decision is separate
  from this deployment and recovery check.
