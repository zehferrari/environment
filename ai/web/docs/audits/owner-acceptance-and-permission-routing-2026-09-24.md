# Owner acceptance and reviewer-first permissions — 2026-09-24

The owner requested direct checkbox acceptance without an evidence popup,
agent-verifiable checks delegated by default, and permission requests sent to
the task reviewer or Epic manager before the task owner.

An authenticated owner checkbox click now completes an owner check without
requiring written evidence. Optional notes remain supported. The completed-by
identity, timestamp and activity are retained; PM invents no verification
results. Agents cannot complete explicit owner checks. An existing conditional
verdict resumes once all required checks are accepted, with the existing
candidate, plan and checklist fences unchanged.

Acceptance plan steps already defaulted to `reviewer`. The deferral path now
matches that policy: ordinary agent-verifiable checks remain reviewer work,
with the acting Epic manager as reviewer fallback. `responsibleActor=owner`
is available for explicit owner checks or required human access/authorization.
An explicitly owner-assigned plan/check cannot be silently delegated through
deferral. Deferring a check does not complete it or grant deployment permission.
Shared operating instructions and native/scoped HTTP tool contracts explain
the policy, and the checklist displays reviewer responsibility.

Permission routing now selects an available independent task reviewer, then
the manager of an actionable Epic if the reviewer is absent, inactive,
deactivated or self-assigned. The same resolver governs dispatch, server
authorization, scoped runtime tools, checkpoint-grant validation and UI state.
Without either reviewer, the request goes to the reporter. A reviewer explicitly
escalates requests outside their authority; production, destructive/security
changes, expanded scope and incomplete context do not gain agent approval.

Previously, a request could notify a reviewer while also setting the reporter
alert and showing the owner grant button before assessment. Those permission
alerts now wait for escalation; unrelated pre-existing alerts are retained.
The grant button is shown when the owner decision is needed. Routine scoped
approvals still wake the assignee and retain the single-request grant boundary.

Validation covers real browser clicks with no owner popup, owner-only completion
without fabricated evidence, concurrent acceptance, reviewer/Epic-manager
deferral, explicit owner reservations, permission recipient precedence,
unavailable/self reviewer fallback, escalation and authorization limits.

All 71 workflow suites passed after updating two historical tests that expected
immediate owner alerts and making a continuation fixture explicitly due instead
of racing database/application timestamps. The initial full run passed 68 suites;
the three affected suites passed on targeted recheck. TypeScript, ESLint on
changed code, and the real checklist browser fixture also passed.

The live read-only audit found no unreviewed permission rounds needing recovery.
Existing explicit owner checks retain their assignment. WDT-14's recovery check
was moved from an unrecognized presentation group to the standard review group
so its checkbox is visible; its criterion, responsibility and completion state
are unchanged, and presentation grouping is excluded from the accepted verdict's
checklist fingerprint.

Deployment: `pm-switch --database=main main`, receipt
`/srv/Data/pm/deployment-receipts/2026-09-24T024032Z-main-b8d121d8338c.receipt`.
Both PM services are active and public login/referenced CSS return HTTP 200.
The installed `task-tools.js` matches this worktree. Shared agent instructions
were reconciled with `openclaw-doc-sync`. Changes remain uncommitted on `main`.
