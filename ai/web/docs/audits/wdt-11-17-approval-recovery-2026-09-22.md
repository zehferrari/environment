# WDT-11 and WDT-17 recovery — 2026-09-22

## Findings

WDT-11 remained blocked because its existing formal blocker mixed physical-device
validation with unfinished independent automated checks and evidence uploads.
Updating shared instructions alone did not resume that already-blocked task.
An owner-authorized recovery notification asked Asdrubal to correct the blocker,
continue independent work from its checkpoint, and retain the physical-device
acceptance requirement. Asdrubal recorded `clear_blocker`; the task returned to
active execution with its reporter alert cleared. This is recovery, not evidence
that the remaining acceptance checks have passed.

WDT-17's manager, Barekbaal, had accepted the current Action Plan revision using
`accept_plan_review`. WDT's reporter-only approval policy withheld `approve_plan`
even though the parent Epic had already been approved. The monitor nevertheless
kept requesting approval from that manager. This was an authorization/recovery
mismatch, not a request for Carmen to rewrite the plan.

Deployment verification also found two Barekbaal retries in `waiting_capacity`
with an empty blocking run ID. Each already had a released execution lease;
creating a new lease violated the unique run ID, and the catch path mislabeled
that error as capacity contention. Retried runs now atomically reacquire their
released lease with a fresh token. The active-agent unique constraint still
prevents concurrent execution. Errors without a real holder propagate instead
of creating an endless capacity wait.

## Owner-approved policy

Approval of any Epic authorizes its current manager to approve child-task plans
while the Epic is To Do or In Progress, including reporter-only projects. This
grant does not allow the manager to approve their own implementation plan. It
does not change permissions for task completion, whole-Epic acceptance, or
deployment. Existing reporter approval and explicit revision delegation remain.
The policy is derived from current Epic state; no task resets or DB migrations
are required. Existing turns need fresh capabilities to receive the new action.

The server authorization, UI data, compact tools, effort selection, workflow
instructions and recovery checks all read this policy. An accepted review that
needs another approver emits a durable notification to that approver. Monitor
probes and the final nudge command suppress repeat requests to an accepted
reviewer who cannot approve. A failed turn by an authorized approver remains
eligible for stall detection.

## Verification

Regression coverage includes reporter-only standalone plans, approved and
unapproved Epics, inactive Epics, self-approval exclusion, unchanged completion
permissions, accepted-review handoff, native/scoped runtime capabilities, actual
API approval by the Epic manager, revision fencing, and monitor recovery parity.
The 30-tool-call episode limit and unavailable steering are separate runtime
issues; this change does not redesign those budgets.
