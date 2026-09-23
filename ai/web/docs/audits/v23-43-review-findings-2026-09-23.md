# V23-43: review corrections missing from the checklist

Asdrubal returned candidate `cbb41ab1e10452019812818d0b79cbc18f8eac3d`
with three groups of corrections. PM saved his review comment and returned the
task to the assignee, but its six implementation checklist rows stayed complete.
The operating guide told the assignee to add subtasks after feedback; the compact
runtime did not carry that instruction, and the workflow did not enforce it.
Successful notification delivery was therefore insufficient evidence of a
complete handoff.

The fix makes structured findings part of `request_review_changes` /
`review_feedback`. Each supplies a title, acceptance criteria, and approved-scope
reference. In the existing decision transaction, PM creates an immutable
`ReviewFinding` linked to its actual review run, candidate, plan revision and
new pending implementation subtask. Only then does the transaction record the
review decision and schedule its assignee handoff. Failure rolls everything
back. Replay uses the existing command receipt; a stale review run/candidate is
rejected. PM does not infer additional scope from review prose.

Correction completion requires explicit evidence. Open finding records gate
resubmission and final acceptance independently of the checklist projection,
including an accidentally deleted checklist row. Ordinary deletion cannot
remove a correction. To supersede one, the current independent reviewer or owner
must cite a later owner-authored task instruction and rationale; PM removes its
checklist row while preserving the finding as superseded, not completed. A
supersession is not authorization for expanded implementation.

The browser review form, native tools and scoped HTTP share the structured
contract. The Sub-Tasks tab shows criteria, scope, reviewed candidate, completion
evidence and supersession reasons. Context reads expose the findings separately
from truncated history. Compact runtime instructions are conditional and carry
only a bounded sample; full details remain available through scoped context.

Deploy migration `20260923010000_review_findings`, PM, shared WORKFLOW.md and
PM plugin 0.1.15 together. Historical comments are not automatically converted:
V23-43 has a later owner instruction removing date/time switching, and its
current candidate must be reconciled by the reviewer before obsolete findings
are superseded or applicable checks are resolved.

Validation uses disposable databases: missing findings, unauthorized reviewers,
stale workflow version/candidate, idempotent retry, incomplete-checklist gates,
evidence, reopen, forbidden deletion, owner-instruction supersession, and a
failure after the first insertion (no partial subtasks, comments or handoff).
Existing review/finalization, native tool and compact-runtime tests exercise
compatibility. Real scope judgment and evidence assessment remain the agents'
responsibility.
