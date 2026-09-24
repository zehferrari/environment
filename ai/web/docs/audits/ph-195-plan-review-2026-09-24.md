# PH-195 plan review and checklist progress — 2026-09-24

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

Deployment is deferred at the operator's request. No `pm-switch`, gateway
reinstallation, live workflow recovery or database mutation was performed by
this change. Both fixes remain together on `fix/plan-review-handoff` in the
`fix_plan-review-handoff` worktree.

## Validation

- Full combined workflow gate: 71/71 suites passed.
- TypeScript (`tsc --noEmit --incremental false`) passed.
- ESLint passed for the changed JavaScript and TypeScript files.
- `git diff --check` passed. Production behavior remains unverified until the
  operator chooses to deploy these changes.
