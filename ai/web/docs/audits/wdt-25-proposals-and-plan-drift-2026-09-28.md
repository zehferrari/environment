# WDT-25 proposal discovery and operational plan drift

## Findings

WDT-25's owner asked Barekbaal to consolidate the remaining migration work.
Proposal `cmukqazf9088aovp7813sgrl3` was correctly stored pending against
task-comment grant `cmukq1wz307lvovp78gv28bct`. The agent then directed the owner
to Barekbaal's direct chat, which deliberately excludes Task/Epic proposals.
The pending review card belonged on WDT-25. There was no global proposal inbox,
and the proposal response returned no review link. Task proposal lists also
used a cache tag that Apply/Reject did not invalidate.

The approved WDT-25 plan still required restoring the destination to its earlier
stopped/fenced state and proving browser routing back to moonlight. The owner
subsequently instructed the agent to make the destination serve correctly and
proxy public traffic to it from moonlight. The agent performed that change but
left its plan and browser-restoration blocker unreconciled. Finishing the old
cleanup literally would contradict the owner's current intended host state.

The task also records repeated runtime browser configuration edits being
overwritten by managed reconciliation, with gateway restarts interrupting turns.
The canonical settings are under `/srv/agents/openclaw/<agent>/openclaw.json`.
It reports a roughly 40-second public outage after the source app was stopped
before the new proxy route's TLS behavior had been verified.

## Changes

- Owner-only `/proposals` lists pending changes across projects, with Apply,
  Reject, previews, stable proposal anchors, and original-conversation links.
  Desktop and mobile navigation show the pending count. Source tasks show a
  prominent review link.
- Proposal cards show their publication date/time in AEST and the current
  status of referenced Tasks/Epics, the source conversation item, and the
  Tasks' current Epics. Statuses are resolved on page load outside the proposal
  cache. Archived, deleted, and unavailable items are identified; deleted
  items expose no title or detail link. Proposal-only temporary references
  are omitted. Context is project-scoped and sent only to owner review surfaces.
- Pending proposal API responses, including idempotent retries, return
  `reviewUrl`. Agent guidance requires using it rather than guessing a chat
  location. Apply/Reject invalidate the task proposal cache and inbox/navigation.
- Shared and compact task instructions explain canonical browser configuration
  and scoped monitor/operator repair, avoiding runtime-edit/restart loops.
- Operational workflow guidance requires revising conflicting final-state
  requirements after later owner instructions, preserving evidence and resolving
  obsolete blockers. Live routing must be verified from the source before the
  old service is disabled, with rollback and write ownership accounted for.

The WDT-26/WDT-27 proposal remains pending for owner review. This repair does
not approve that proposal, delete WDT-27, change live WDT routing, or assert that
unperformed tests passed.

## Validation and recovery

All 71 workflow suites, TypeScript, proposal authorization/review-link tests,
and customer/owner navigation DOM tests passed. Focused lint had no errors
(one existing image-element warning). The final clarified pre-approval wording
also passed the compact runtime and CLI prompt budget tests.

The consistent database backup passed `quick_check`:
`/srv/Data/pm/backups/wt-main-before-wdt25-recovery-20260928T061627Z.db`.
The recovery command is fenced to WDT-25 workflow version 2, plan version 2,
its active cycle and the two recorded owner instructions. It asserts that the
checklist completion dates and evidence remain unchanged on reopening.

Before recovery, the canonical and runtime browser settings already matched.
While Barekbaal had no active PM turns, the operator removed only the exact
temporary WDT hostname resolver override from the canonical `extraArgs`,
synchronized the runtime copy and restarted the gateway. Both copies now omit
the override. The existing hostname allowlist remains, `noSandbox=false` and
`dangerouslyAllowPrivateNetwork=false`; the gateway is active. The agent must
verify the current public route rather than prove the obsolete moonlight build.

Deployed the uncommitted `main` worktree through `pm-switch --database=main main`.
The final receipt is
`/srv/Data/pm/deployment-receipts/2026-09-28T062212Z-main-dabfc1e4db35.receipt`.
An intervening rebuild attempt hit the database-busy checkpoint guard after
stopping PM; the intact preceding build was restarted immediately, then the
guarded deployment was retried successfully. Both services are active, login and
CSS return HTTP 200, and unauthenticated `/proposals` redirects to login.
The final task-runtime wording is present in the deployed standalone chunks.

Recovery command `wdt25-owner-final-state-reconcile-20260928` was accepted as
transition `cmukv1s0q0005ovwjjy71ztnr`, moving WDT-25 to workflow version 3
with plan v2 `revision_required`. Every existing completion timestamp and
evidence entry was unchanged. The durable notification completed and Barekbaal's
run `26f55a12-74ea-4473-b8fd-bc8cb34edd1a` was admitted and streaming.
It subsequently completed with `submit_plan`: plan v3 is now submitted, and
Asdrubal's independent review run `c7af9566-ec5b-443c-af40-7649d9e53102`
was admitted. The task remains To Do pending this plan's approval, rather than
silently resuming against the conflicting v2 requirements.
