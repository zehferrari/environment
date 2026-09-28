# WDT-11 / WDT-14 owner acceptance recovery — 2026-09-24

WDT-11's latest reviewer turn (`3dad395e-198e-4cc9-afe9-5fd65aefe71e`)
accepted candidate `eb856a4dc641abc2f5879b515692908ac40cdebd` in prose,
but reported `review_done` rejected with `checklist_incomplete`. Its three
physical-device checks were deferred under owner instruction
`wdt11-owner-validation-deferral-20260922`, before checklist actor metadata
existed. All three still had the default `responsibleActor=assignee`, preventing
the newer conditional acceptance path. No code correction was requested.

WDT-14 correctly stopped on an authenticated editor save/reload check. Its
isolated fixture, lint/build, schema and persistence evidence did not prove the
authenticated route. On September 24 the owner explicitly chose to defer that
check to final acceptance and allow code review. This authorizes no publication
or deployment of the WDT application.

The reusable `defer_acceptance_check` operation had the same metadata omission:
it changed only `kind` to `review`. It now also records `responsibleActor=owner`
and `acceptanceGate=task`. The item remains incomplete and linked to its approved
plan. The compact runtime explicitly tells reviewers to call `review_done`
when only owner checks remain: PM records `accepted_pending_owner`; a prose
verdict alone is not acceptance.

Recovery is scoped to the exact tasks, workflow versions, active cycles and
current review candidate. WDT-11's three existing rows retain their text and
pending state, with their owner responsibility corrected from the recorded
instruction. WDT-14 gets a separate pending owner review check; its broad
implementation verification item remains open for the assignee to complete with
evidence. Owner comments and an audit preserve the authorization and original
rows. Durable, cycle-bound notifications resume the reviewer and assignee;
neither a reviewer verdict nor test completion is fabricated.

Regression coverage exercises deferral through the actual command, rejects
agent completion of the deferred owner item, accepts a conditional reviewer
verdict, and verifies no finalization procedure starts while owner evidence is
missing. The existing acceptance lifecycle suite checks owner evidence,
candidate/plan/checklist fencing, replay and finalization.

## Deployment and observed recovery

Deployed the uncommitted `main` worktree through `pm-switch --database=main main`.
Receipt: `/srv/Data/pm/deployment-receipts/2026-09-24T020328Z-main-b8d121d8338c.receipt`.
Both PM services are active; public login and the referenced CSS return HTTP 200.
Reviewer-permission, acceptance-lifecycle and compact-runtime regression suites,
TypeScript and focused ESLint checks passed. The reviewer-only guidance remains
within the compact runtime's existing prompt-size limits.

Audited recovery: `cmuew1ffv000bovls0pwhij5w`. The WDT-11 recovery comment is
`cmuew1ffp0001ovlsvn2xzt6s`; WDT-14's explicit owner instruction is
`cmuew1ffq0003ovlslxvabu37`, with pending owner check
`cmuew1ffr0005ovlsekuswj5a`. Both durable notifications completed delivery.
Barekbaal entered streaming run `0ab1cd0a-b06b-44e2-8177-e3bed06eb391` for
WDT-11; Asdrubal entered streaming run `a155398f-12f7-4ab2-8ec3-4b4aa5872ab3`
for WDT-14. Dispatch is not a reviewer verdict or proof of completed tests.

Barekbaal subsequently recorded `review_done` on the unchanged WDT-11 candidate;
review run `cmucep2mj0001ovkg9dzrm81l` is now `accepted_pending_owner`, with
all three physical checks still open. Asdrubal recorded `clear_blocker` citing
the WDT-14 owner instruction, cleared the reporter alert, and completed the
remaining implementation verification item. The separate owner check remains
open while the review handoff proceeds.
