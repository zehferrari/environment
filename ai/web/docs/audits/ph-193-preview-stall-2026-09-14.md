# PH-193 preview stall — 14 September 2026

Task: [Share price at less than two decimal places](https://agents.vixi.au/projects/patricia/tasks/cmtuwol5u0zjmovg65fyc6b3i).
Evidence: read-only operational `wt-main.db`, the registered Patricia task
worktree, and read-only `ssh dev` inspection. Times are Brisbane (AEST).

## Current state and cause

The task remains In Progress at workflow version 16, assigned to Asdrubal with
Carmen reviewing. Its execution state is blocked, its repository phase is
active with no repository error, and its latest agent runs completed normally.
There has been no task activity since 11 September at 10:14:53. This is a
verification handoff stall, not an active model run or a failed PM service.

The active blocker is comment `cmtvay8418nu2ovk89zk6jdd6`, raised on 10 September
at 19:05. The managed browser rejected the isolated loopback fixture with
“browser navigation blocked by policy”. The requested resume condition is a
permitted preview serving the form rework, with disposable test-order access.
No evidence currently establishes that this condition has been satisfied.

The earlier missing-plan-tool/scope blocker was resolved by the owner's explicit
form-rework grant at 18:53 on 10 September (`cmtvaif5d7tp9ovk8531igmfy`). Do not
request that same approval again. The compact tool list excludes `submit_plan`
for an already-approved In Progress task; repeatedly searching for it was not
an actionable recovery path.

On 11 September at 10:09 the owner directed testing to dev.patricia.com.au.
Carmen verified dev still served export-only `c2bfaaa33` and proposed staging the
three application files without committing or pushing. Asdrubal instead stopped
at a request for PM-managed publication/deployment. The compact contract's
unqualified prohibition on deployment conflicted with this owner-authorized
standalone preview and supplied no way to finish pre-submission verification.

## Rechecked evidence

The registered task worktree is still based on `c2bfaaa33` and contains:

- modified `components/com_companies/helpers/companies.php`;
- modified `components/com_companies/views/company_officers_members/tmpl/default.php`;
- new `components/com_companies/helpers/shareamount.php`;
- new form and persistence regression tests.

The existing tests were rerun: 34 form cases and 64 persistence/export cases
passed; all three application files passed PHP lint and `git diff --check`
passed. These are focused fixture tests, not proof of browser interaction or
an actual saved-order round trip.

Dev has since changed. On 14 September it is clean on
`aml-ctf_resolutions-greenID` at `7ef2f60db` (PH-179), and the new `shareamount.php`
is absent. Do not overwrite this newer deployment using the stale 11 September
branch assumption.

The repository row also retains the previous closed cycle ID
`cmtv8xpyl4n31ovk8hbl3dzpu`, while the task's active cycle is
`cmtv9wtte6mtxovk8jz4ibigy`. This is a separate correlation discrepancy to check
at submission; the current stall predates submission and has an explicit
preview blocker. No cycle/version values were edited directly.

## Correction and recovery handoff

The compact contract and repository guide now distinguish PM-owned publication
from an explicitly owner-authorized standalone test preview. They require
current-target inspection, preservation of other work, actual-file verification,
and respect for browser policy. Production deployment and Epic checkpoint
ownership remain unchanged.

Prepared recovery instruction for Asdrubal:

> Resume PH-193 from the existing approved form-rework scope and dirty registered
> worktree; do not repeat planning or scope approval. The 98 focused tests still
> pass. Your owner-authorized standalone test preview does not require a manual
> commit or push. Dev has moved to another task at 7ef2f60db, so first coordinate
> the test slot or obtain an isolated preview; preserve that deployment. Verify
> that the preview actually serves the three form-rework files and that the
> managed browser and disposable test-order flow are accessible. If access is
> denied, report the exact current refusal without bypassing policy. Clear the
> existing preview blocker only with evidence that its resume condition holds.
> Complete the approved browser/save/reload/RA export checks for 0.1, 0.10 and
> 0.01, both share classes and the specified paid-value cases. Then submit through
> ready_for_review, leaving commits and publication to PM. Preserve the CSV and
> customer orders. Record a precise coordination blocker if the test slot is
> unavailable instead of treating branch publication as a prerequisite.

This audit did not post that instruction, wake agents, stage files on dev,
clear the task blocker, or change PM database state. The instruction correction
requires deployment/reconciliation before it reaches future task turns.

## PM validation

The existing `test:pm-task-runtime` integration suite passed against its
disposable SQLite database, including native and scoped-HTTP contracts, role
fences, replay, plan feedback, and compact prompt budgets.
