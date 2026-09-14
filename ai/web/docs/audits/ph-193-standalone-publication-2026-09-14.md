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

## PH-193 publication confirmed

At 11:09 AEST, the existing recovery completed its normal submission path.
PM published `e9ec3d3c795c0c0ef76aff39a7df5792d1755ea5` to
`origin/PH-1010-share-price-at-less-than-two-decimal-places-such-as-0-1`.
An independent `git ls-remote` confirmed that exact SHA and `git show` confirmed
the three application files and both regression tests are included. The task
entered Review at workflow version 17 and Carmen began independent review.
No additional recovery comment, owner grant, or agent wake was needed.

The verification note explicitly limits its live evidence to full-form checks,
anonymous Next Step POST/server-session reload and local production-export
replay. Authenticated saved-order reopening/admin download was not tested;
that limitation is available to the reviewer and has not been rewritten as a
passing test. The transient session-busy continuation failed, but the subsequent
submission succeeded without restarting Asdrubal's gateway.

## Activation

At 11:15 AEST, `pm-switch` deployed `ec0a06b8e671738daf27f85a5b0fefc06bfbc91c`
from `fix-pm-standalone-checkpoints`, explicitly selecting
`PM_BRANCH_DB=/srv/Data/pm/wt-main.db`. Production build and type checks passed,
with existing unrelated lint warnings and no pending migrations. The switcher
verified both services and the referenced hashed CSS. Independent process-env
checks confirmed both services use `file:/srv/Data/pm/wt-main.db`; the public
HTTP/2 login returned 200 in 68 ms. `openclaw-doc-sync` processed all four agents.

Receipt: `/srv/Data/pm/deployment-receipts/2026-09-14T011535Z-fix-pm-standalone-checkpoints-ec0a06b8e671.receipt`.

PH-193 was Done at workflow version 18 after reviewer acceptance and repository
finalization. No extra wake, manual task-state edit, or force push was needed.
This activation record is a later documentation-only commit. The application
fix and audit are pushed on the feature branch; no PR was created or merged.
