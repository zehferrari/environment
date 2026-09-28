# WDT review waits — 24 September 2026

At 17:32 AEST, WDT-14, WDT-15 and WDT-21 all had recorded
`accepted_pending_owner` verdicts. Their notification effects completed and
their reviewer runs ended normally. These were owner-acceptance waits, not
lost reviewer dispatches.

- WDT-14: the owner's explicit earlier instruction deferred authenticated
  editor save/reload acceptance. That check remains open.
- WDT-15: agents revised the plan to assign rendered-browser verification to
  the owner after Barekbaal's managed browser denied loopback navigation.
  No owner instruction authorized that reassignment. Barekbaal lacked the
  specific localhost exception that Asdrubal already had.
- WDT-21: owner confirmation of migration window, retention and release
  strategy remains open. Discovery/runbook review passed; this does not
  authorize migration or traffic changes.

The owner explicitly authorized `127.0.0.1` for Barekbaal's managed browser and
returning WDT-15 verification to him. The canonical browser config now contains
that host exception, with `dangerouslyAllowPrivateNetwork=false` and
`noSandbox=false`. Config sync and an idle gateway restart applied it. A managed
`about:blank` tab navigated to `http://127.0.0.1:3001/` and returned a DOM
snapshot; the diagnostic tab was then closed. This proves access, not WDT-15
acceptance. Other private-network hosts were not authorized.

## Corrections

Boards now label conditional verdicts **Awaiting owner acceptance**, and the
task overview links to its pending checklist. The checklist banner and owner
notification explain direct checkbox acceptance without required evidence
notes. Initial acceptance items remain counted during later review rounds;
customer views retain their existing privacy boundary.

An agent revising a reviewer plan to add owner checks must provide
`actionPlan.ownerInstructionCommentId` referencing a non-deleted owner
instruction on that task. Missing references, agent-authored comments and
another task's instructions are rejected without modifying the plan. Shared
instructions retain reviewer responsibility when tools are unavailable and
request the specific access repair.

WDT-15 also exposed a repository classification error: acceptance-only plan
revision reset the task's recorded base to its existing candidate `64fd5da`,
while the Epic integration ref was still older. Candidate-equals-task-base did
not prove there was nothing left to merge. Epic children now qualify for the
no-change path only when their candidate also equals the verified Epic base;
otherwise the normal merge path remains required. Standalone classification
is unchanged.

All 71 workflow suites passed. Focused checks also passed for plan ownership
authorization, conditional acceptance, repository base classification,
checklist groups, customer DOM privacy and compact runtime budgets. TypeScript
and lint passed. The agent plugin schema and shared docs were refreshed.

Before recovery, a consistent SQLite backup passed `quick_check`:
`/srv/Data/pm/backups/wt-main-before-wdt15-review-recovery-20260924T0745Z.db`.
Recovery uses the canonical `request_plan_revision` command, fenced to WDT-15
plan v2, workflow version 9, its active cycle and exact accepted candidate.
It preserves implementation and evidence, reassigns only the browser acceptance
requirement, and lets the agents record their own subsequent decisions. No
owner checkbox or browser test is marked complete by the recovery.

## Activation

Deployed uncommitted `main` through `pm-switch --database=main main`.
Receipt: `/srv/Data/pm/deployment-receipts/2026-09-24T074745Z-main-b8d121d8338c.receipt`.
Both PM services are active; public login and its referenced stylesheet return
HTTP 200. Recovery command `wdt15-owner-authorized-reviewer-browser-20260924`
was accepted as transition `cmuf8d2l20005ove496k6zf7f`, advancing WDT-15 to
workflow version 10 and reopening plan v2 for the narrowly scoped revision.
The durable assignee notification completed. Asdrubal submitted plan v3 with
`verify-resize-preservation` restored to `responsibleActor=reviewer`, completing
run `7e03cec8-561d-48f5-93ec-0a6961915032`. Barekbaal's follow-up
`2e81154b-bac6-4cfe-94f1-abf7431dae53` was admitted for the revised plan.
Rendered-browser acceptance remains pending for the reviewer to perform.
WDT-14 and WDT-21 retain their recorded verdicts and pending owner checks.
