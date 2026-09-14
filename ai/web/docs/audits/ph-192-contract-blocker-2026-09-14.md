# PH-192 contract rejection and workflow audit — 14 September 2026

PH-192 (`cmtrwi4ondjtyov2k9wfotit6`, Dev CBA payment down) remains In Progress
with its final end-to-end verification checklist item open. Main database
`wt-main.db` records an active blocker at `cmu0po98aatg2ov4rv2jualg0`.

The Dev payment invocation reached CBA and was refused because its transaction
ID was 50 characters; the gateway permits at most 40. `generateTransactionKey`
in V23 candidate `682a05db` concatenates a 13-digit millisecond timestamp,
a hyphen, and a 36-character UUID. This defect predates the V23-39 legacy-origin
change. Earlier artifact verification correctly showed V23-39 was deployed;
its narrower session-initialization acceptance did not test payment completion.

The V23 correction returns the full 36-character UUID. New handler tests
simulate the observed gateway rejection in both legacy and invoice paths,
assert stable identity on a transport retry and distinct identity for a new
invocation. Both tests failed with the original implementation. The corrected
full layer suite passes 273 tests. No payment is made by these tests.

PM also contributed: any mention of browser, Playwright or Chromium classified
technical evidence as a fresh-session fault, and even non-transient errors got
unconditional fresh-session retry guidance. This instructed repeated external
calls after a source defect had been identified. PM now limits browser fault
matching to actual failure descriptions. A dependency contract violation with
source inspection and an independent local reproduction can be reported
without a prior incident round. Self-directed blockers and vague/single-observation
failures remain rejected or internal incidents. Guidance explicitly avoids
replaying payments merely to collect escalation evidence.

The fix is prepared on isolated branches. This audit does not claim a live
Lambda or PM deployment, clear the task blocker, or claim end-to-end payment
success. Those require the exact deployment and subsequent verification.

## Continuation context correction

At the follow-up inspection, PH-192 was still In Progress, workflow version 2,
and its execution detector correctly reported `blocked / external_dependency`.
The latest run had finished with `flag_blocker`; no workflow reset was needed.

Compact task turns clipped the entire rendered checkpoint to 2,400 characters.
Completed work and evidence appeared before the exact next action and risks;
PH-192 episode 11 alone stored 753 completed-work characters and 1,199 evidence
characters before its checklist and next action. An agent subsequently reported
fetching the full checkpoint to recover the truncated action. Compact turns now
reserve separate fields for the complete persisted next action, risks, checklist,
evidence and completed work, and identify fields whose details were omitted.
The runtime regression exercises the authenticated snapshot with oversized
checkpoint sections and verifies the next action and risk remain available.

The native contract also explicitly relies on PM execution ownership instead of
routine sibling-session enumeration. This reduces unnecessary orientation;
it does not claim that checkpoint clipping explains every exhausted episode.

## Follow-up validation and deployment status

The operator maintenance branch is `fix-ph192-pm-workflow`, based on merged
main `46880a0`. The checkpoint regression failed on the old compact snapshot
because `nextAction` was unavailable after clipping. It passes after the change.
The full-history read also returns the authenticated agent's full checkpoint;
routine reads remain bounded and other agents do not inherit that checkpoint.

Validation passed: `test:formal-blocker-validation`, `test:pm-task-runtime`,
`test:workflow-regression-blocker` (117 assertions across four cases),
`typecheck`, and `git diff --check`. All workflow test mutations used isolated
temporary databases. The production task and blocker were inspected read-only.

Automatic approval review rejected the proposed live deployment because it
would restart the shared PM service on the operational main database without
explicit approval for this deployment. The repair remains prepared, not live.
The proposed switch selects `/srv/Data/pm/wt-main.db` explicitly; its fallback
is the validated `main` worktree at `46880a0` using the same database.
No Lambda deployment, payment retry, agent wake, or task blocker clearance
has been performed as part of this follow-up.
