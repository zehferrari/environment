# Mission Control autonomy tuning — 2026-09-23

The failure pattern was missing supported transitions and inconsistent execution
bookkeeping. More prompt restrictions could not make an approved plan editable,
turn a consumed permission into reusable authority, or distinguish deliberate
silence from transport failure. This change implements those paths and tests the
installed gateway lifecycle as well as database transitions.

## Workflow changes

- `request_plan_revision` reopens an exact approved revision without a manual
  status reset. Existing worktrees and evidence remain. Stale execution is fenced,
  queued procedures are superseded, and old grants are revoked. In-flight or
  uncertain repository effects must settle before revision.
- Plan steps declare implementation/acceptance phase, responsible actor, and
  verification environment. Unchanged requirements retain evidence. Approval
  archives replaced requirements with their original completion state.
- A reviewer can record `accepted_pending_owner` for a candidate whose only
  remaining task checks belong to the owner. Owner evidence resumes that verdict
  once, only for the same candidate, plan version and requirements. Reviewer
  identity is retained. Changed definitions cannot inherit an old verdict.
- Project `ownerAcceptancePolicy` defaults to `task`. An explicit `epic_release`
  policy applies to newly approved owner checks: child tasks can finish and unlock
  dependencies while the outstanding checks gate Epic completion. Existing rows
  are not silently reclassified or waived.
- Development publication supports a standing grant under an explicit owner
  policy. Its plan, assignee/reviewer, repository, branch, named target, deployment
  configuration and pinned pipeline files must still match at execution. Each
  attempt has a separate durable identity. PM-controlled pushes share an
  environment lease and deployment verification must report the exact SHA.
  See [deployment configuration](../project-deployment-config.md).

## Execution reliability

Directed comments reach their named recipient. Owner instructions wait at the
current execution boundary rather than cancelling useful work. Continuations use
one durable ledger and cannot be rearmed by late callbacks. Breakers classify
transport failures separately from legitimate model outcomes, and critical probes
are atomically claimed. Recovery checks current permission validity and consumption.
Human notification audit records actual delivery attempts and missing destinations.

The gateway consumes the installed SDK's deliberate-silence result, preserves
idempotent terminal callbacks, fences late replies, and renews liveness during
long tools. A budget warning requests a useful checkpoint; an acknowledged
checkpoint atomically seals the episode and schedules its successor. Hard limits
remain as a fallback. Provider billing aggregates are distinct from verified
latest-call context occupancy; unknown occupancy stays unknown.

Reconciliation uses owned active work with a fair scan. Historical diagnostics
remain available read-only. Terminal stream retention reconstructs a durable
snapshot before deleting redundant frames, including aborted turns. Completed
comments, Thinking, checkpoint evidence and workflow audit identities remain.
Default retention is 7 days for redundant terminal frames and 30 days for expired
transport payloads. Maintenance runs at boot and with hourly maintenance.

## Defaults and rollout boundaries

The schema migration is additive. Existing approval and checklist meanings are
preserved. Standing publication remains opt-in; configuring a target does not
retroactively authorize an old or unassigned plan. External publishers must
participate in shared environment coordination; a PM database lease cannot lock
an independent CI system. Real production approval boundaries remain unchanged.

Apply the migration to the actual worktree database via `pm-switch main`, which
builds and restarts both PM services. Install PM channel plugin 0.1.16 and restart
gateways; run `openclaw-doc-sync` to activate the agent workflow contract. A website
rebuild alone does not activate gateway changes. Keep a consistent database backup
and the previous plugin/config bundle before rollout.

`pnpm test:workflow` includes the new active-plan, acceptance, notification,
standing-publication and installed-runtime suites, plus the previously omitted
planning, reviewer-permission, review-findings and admission regressions. The
read-only `pm-task-workflow-report.mjs` exposes rejection counts, permission rounds,
human comments, empty runs and hard budget closures alongside timings/usage.
Compare matched completed tasks after rollout; historical missing telemetry is
not evidence of zero friction, and passing tests do not prove a production rate
improvement before new work has run.

## Validation recorded before publication

- Complete workflow gate: 68/68 suites passed; monitor recovery: 41 tests passed
  and registered in the aggregate gate for subsequent runs.
- TypeScript and ESLint on all 88 changed/new JavaScript/TypeScript files passed.
- A consistent clone of the production database migrated successfully, preserving
  460 tasks, 1,692 checklist rows, 93 plans and 289 review runs. SQLite integrity
  passed with zero foreign-key violations. Existing Prisma introspection drift
  in the two chat-message tables was unchanged from the pre-change baseline.
- Private live backup: `/srv/Data/pm/backups/workflow-autonomy-20260923T064016Z`
  (database, gateway/plugin configurations, monitor and original source commit).
