# PH-193 standalone publication recovery — 14 September 2026

PH-193's origin branch remained at `c2bfaaa33` while the approved form rework
existed only in its registered worktree. PM owns commits and publication, but
`ready_for_review` requires finished verification and the intermediate
`publish_checkpoint` action was limited to Epic children. A standalone task
needing a remotely deployable commit could therefore stall before submission.

PM now supports an owner-authorized standalone checkpoint. It commits the
registered task worktree, pushes the exact feature SHA without force, verifies
origin, and keeps the Task In Progress with its original review base and open
verification checklist. Production branches, primary checkouts, and local-only
Epic children cannot use this publication path. The existing Epic checkpoint
flow retains its integration-branch publication and baseline advancement.

The permission blocker now records the task and target branches required by
the scoped grant button. The compact runtime, legacy notifications, recovery
prompt and agent guides describe the standalone path. A durable authorization
trailer prevents a retry from publishing later edits under a consumed grant;
a failed push preserves the commit and a remote divergence is never reset.

Validation: the standalone integration suite covers real local Git remotes,
push rejection/retry, replay with later dirty files, divergence, protected and
Epic branches, owner grant, orchestrator and runner execution, retained review
base, open checklist and single-use authorization. The workflow boundary,
repository workflow, task runtime and blocker permission suites passed; the
existing Epic merge and checkpoint-blocker lifecycle suites also passed.
TypeScript compilation passed. The workflow-agent-rules suite fails its old
source-text assertion about clearing a Task branch override on both the
previously deployed branch and this branch; it is not a new regression.

Deployment must retain `/srv/Data/pm/wt-main.db`. PH-193's code publication and
PM activation evidence are recorded after execution below.
