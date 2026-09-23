# V23-43: reviewer decisions for scoped permissions

V23-43 recorded four blocker rounds and three human permission grants. The
single-use checkpoint lifecycle was behaving as designed, but the UI and both
publication fences accepted only the owner. An assigned reviewer could discuss
a request without granting it. Repeated blocker notifications also shared a
workflow-version key even though each permission round needed a new decision.
Publication grants were described as “publish and deploy” although checkpoint
execution only publishes; deployment verification is a separate operation.

The independent resolved reviewer now acts as manager through the authenticated
`review_permission` workflow action. Requests include `permissionContext`:
`environment`, exact `target`, `changesScope`, `destructive`, `securitySensitive`.
The reviewer reads the full approved plan, examines actual effects rather than
trusting request flags, and records an explicit `approve`, `decline`, or
`escalate` decision with `rationale`, `blockerCommentId`, `actionPlanId`,
`actionPlanVersion`, and `planStepIds`. No decision is inferred from prose.

- Approval requires an approved current plan, an independent reviewer, matching
  plan steps, a current ungranted request and a named non-production target.
- Production, unknown targets, destructive/security changes and scope expansion
  require owner/reporter escalation. Unstructured legacy requests fail closed.
- Decline closes only that request without granting permission; the assignee
  receives feedback to choose an authorized approach or revise the plan.
- Escalation retains the blocker, alerts the reporter and records the reason.
- Approval creates a durable exact-request grant and a transactional outbox
  notification to the assignee. Generic grants close their round immediately;
  checkpoint grants remain open until publication settles.
- Checkpoint admission and the repository runner both verify the structured
  reviewer grant against the current reviewer, assignee, cycle, plan revision,
  request and publication branch. Existing owner grants remain supported.
- Each blocker wake has its own comment identity. Reviewer decisions, grants
  and successor notifications are transactionally recorded and replay-safe.
- Native tools and scoped HTTP share the same orchestrator. The compact runtime
  and read API carry `currentPermission`, independently of clipped history.

PM channel plugin 0.1.14 exposes the new tool. No database migration is required.
Deploy the webapp and reload the plugin on enabled gateways; propagate shared
WORKFLOW.md through the managed worktree reconciliation. Existing grants are
not replayed and no previous request is automatically approved.

Validation: disposable-database integration exercises self/outsider approval,
plan fencing, step references, scope escalation, decline, duplicate decisions,
checkpoint admission/single-use and runner authority revocation. Existing
checkpoint, permission-grant, action-effect and native-tool tests cover the
unchanged owner path and transport contracts. Real scope judgment remains the
reviewer's responsibility; PM enforces the recorded authority boundaries.

The final live check also found a later, different blocker: approved plan v2
step 6 explicitly says owner-owned post-deployment cut-over is not part of
implementation completion, but its linked checklist row was `implementation`.
`defer_acceptance_check` lets the independent reviewer explicitly move that
open linked item to `review`, citing the exact blocker, checklist item, plan
revision and rationale. It preserves the row, criteria link and incomplete
state. The exact implementation blocker closes and the assignee is notified;
`guardAcceptReviewChecklist` still prevents Done until final acceptance. No
production action or completed check is manufactured. This action applies only
to In Progress tasks with a decision/person blocker and current approved plan.
