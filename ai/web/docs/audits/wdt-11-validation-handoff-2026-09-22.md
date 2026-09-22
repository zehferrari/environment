# WDT-11 validation handoff — 2026-09-22

The latest blocker was raised after independent checks finished, unlike the
earlier premature blocker. The uploaded episode-13 bundle records 526/526
automated checks, 42/42 supplemental checks, lint/build and four geometry tests.
Physical wheel, trackpad and touch checks remained explicitly required by the
approved plan. A missing original before-edit baseline record was also reported.

The owner authorized reviewer assessment of the automated evidence, retaining
physical-device checks for final acceptance. Record this instruction durably
on the task and keep those checks open in the review checklist. Implementation
completion must identify that deferral rather than claim the checks passed.
Reviewers can assess the code and evidence before those checks are completed.

PM already excluded review checklist items from the implementation-to-Review
gate, but did not enforce them at final review acceptance. The orchestrator now
loads both checklist phases and rejects `accept_review` while review items
remain open. Existing implementation checklist enforcement is unchanged.
Regression coverage proves review entry is allowed with deferred review checks,
final acceptance is rejected while they are open, and succeeds once completed.

## Managed browser baseline recovery

OpenClaw 2026.9.3 local-managed profiles do not use the persistent Playwright
new-tab path. Under strict redirect inspection, `browser open <http-url>` raises
the reported policy error. The supported sequence `browser open about:blank`
then `browser navigate <url> --target-id <returned-tab>` uses the managed
navigation path with the existing allowlist and redirect checks. This was
verified against WDT-11's isolated baseline fixture on localhost:3112; no
browser policy was weakened and no direct CDP navigation was used.

The fixture server must use the current test chapter with the baseline source.
Check the loaded page before measuring; a successful navigation command can
still display a 404. Retrospective measurements are supplementary evidence,
never the original before-edit record. The reviewer must explicitly assess
that historical evidence gap instead of asking an agent to recreate history.

The prepared `measure-baseline.mjs` subsequently completed against the verified
fixture. `baseline-dom.json` contains desktop 780×493 and mobile 390×844 DOM
measurements, and explicitly labels them reconstructed after implementation.
The recovery attachment is named `wdt-11-retrospective-baseline.json`.

## Follow-on Epic ancestry failure

The owner instruction worked: Asdrubal cleared the physical-validation blocker,
completed the implementation checklist and submitted at 07:26 UTC. Repository
preflight then found that WDT-13 had advanced `sept-2026` from WDT-11's base
`689470d60e` to `b26742e967`, including shared `TimelineViewer.tsx` changes.
The failure message directed the assignee to merge/rebase while the active
runtime contract assigned all merges and commits to PM. Asdrubal correctly
reported that contradiction; another wake with the same instructions could
not fix it.

The Epic-child verifier now owns base synchronization in the registered linked
worktree. It preserves tracked and untracked work in a local checkpoint before
merging a pinned Epic revision. A changed revision always returns to the
assignee for affected automated checks and fresh evidence before review.
No child ref is pushed. Conflicts remain visible in the PM-owned merge: the
assignee may edit and stage resolved files; PM completes the merge on the next
submission and requires revalidation. Unresolved files, staged conflict markers,
unrelated merges, primary checkouts and wrong branches are rejected safely.
A durable per-worktree record prevents a repeated verifier job from certifying
the source it just changed.

`epic-child-sync-test.ts` exercises preservation, local-only behavior, duplicate
delivery, conflict resolution, marker rejection and worktree boundaries using
real Git repositories. Existing branch-base, repository-workflow, review
submission and compact-runtime checks cover the surrounding handoff.
