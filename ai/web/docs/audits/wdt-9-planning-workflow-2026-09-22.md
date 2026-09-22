# WDT-9 planning workflow — 22 September 2026

## Observed failure

Task `cmuaw1oq7syv6ovulkcf8oj76` remained Backlog at plan revision 5 after
21 September's planning conversation. Reviewer acceptance, requests for the
reporter to approve, and permission-error reports were all interpreted by
`persistTaskReply` as requests for another plan revision. The task required
a PDF attachment, excluding it from the compact runtime despite that runtime
being enabled. Workflow prompts grew from about 30k to 75k characters.
The project required reporter approval; owner chat permission did not create
a delegated approval. Failed turns and capacity retries added further stalls.
The planning task was outside the execution watchdog's Backlog coverage.

## Changes

- Only structured `request_plan_changes` produces revision feedback. Reviewer
  discussion is stored without inventing a workflow decision.
- `accept_plan_review` records acceptance of the exact plan revision and ends
  the turn waiting for authorised approval. It does not authorise execution.
- The Action Plan UI allows the authenticated reporter to delegate approval
  of the displayed revision to the current reviewer. The command is audited,
  revision-fenced and replay-safe. Any changed revision or requested correction
  clears delegation and acceptance. A changed reviewer/reporter cannot inherit
  another principal's delegation. Existing Approve Plan also binds the rendered
  revision instead of silently approving a newer revision on submit.
- Identical plan resubmission returns the existing revision; it cannot generate
  another review wake. Unchanged content after requested corrections is refused.
- Attachment-required coding tasks receive compact context. Plugin 0.1.10 adds
  `pm_attach_file`; CLI backends receive the scoped multipart upload contract.
  The backend rejects uploads using inactive/failed task runs. Upload does not
  finish the task or bypass its attachment/review gate.
- Exact agent approval retries reuse the original server-supplied workflow
  version from the matching command receipt. The orchestrator still verifies
  the full request fingerprint; approval cannot create a second handoff.
- `waiting_capacity` jobs are eligible to retry. Deferring for an occupied lane
  refunds the claim attempt and releases the claim, preventing retry exhaustion
  and orphaned claims before any model execution.
- Backlog tasks enter watchdog snapshots. Failed planning handoffs or repeated
  revisions without progress escalate instead of scheduling another revision.
  Accepted reviews waiting for a human are shown as waiting for approval.

The exact cause of every empty model response in the original incident was not
established. These changes remove the confirmed revision loop, add durable
acceptance, and make exhausted planning failures visible; they do not claim
that providers can never return an empty response.

## Verification and deployment

`pnpm test:wdt-planning` creates and migrates an isolated temporary database.
It exercises the real authenticated agent route, reply persistence, orchestrator,
watchdog snapshot and job worker. It covers acceptance versus approval,
reporter-only refusal, delegation, revision changes, receipt replay, compact PDF
task context, failed Backlog review escalation and repeated capacity deferrals.
Native tool and attachment suites cover generation fences and stored bytes.
Existing runtime, watchdog, and lease suites are also run before deployment.

Deployment requires the additive Prisma migration
`20260922090000_plan_review_decisions`, plugin 0.1.10 on the agent gateways,
and a single `pm-switch --database=main main` build/restart. Do not build the
active standalone tree without restarting. Back up the database and installed
plugin before activation. Rollback may retain the additive nullable columns;
restore the old application/plugin together rather than deleting new audit data.

TypeScript and the workflow boundary check passed. The new WDT fixture,
compact runtime, native tools/attachments, runtime compatibility, 142 watchdog
checks, 41 watchdog database checks, lease lifecycle and 186 workflow effect
assertions passed. Test databases were isolated under `/tmp`.

Activation and task-recovery results are recorded below after deployment.

## Activation and observed recovery

Initial deployment `af3e7db` completed through `pm-switch` at
2026-09-22T01:42:55Z. Login HTML and its referenced CSS returned HTTP 200;
the public login also returned 200. The database migration was applied.
Backup: `/var/backups/openclaw/wdt9-20260922T014010Z/` (SQLite quick_check: ok).
Plugin 0.1.10 was staged and loaded by Asdrubal, Barekbaal and Carmen.
Asdrubal/Carmen advertised the new native tools; Barekbaal correctly advertised
no native tools because its Claude CLI runtime uses scoped HTTP. Karen's
unrelated old accepted-run record was not reset or canceled, and her gateway
was not restarted. Updated WORKFLOW.md copies were synchronized for all agents.

The operator recorded reporter-authorized delegation for existing revision 5
through `delegate_plan_approval`, preserving the task and its history. Asdrubal
approved it; PM prepared `/srv/Code/whitsunday-discovery-trail.worktrees/wdt-9`
and Barekbaal called `start`. WDT-9 reached In Progress at workflow version 2.
The reviewer prompt fell from 71,304 to 8,687 characters; the CLI implementer
prompt fell from 71,575 to 13,943 characters. These are measured PM prompt
characters, not full-model token counts or a latency benchmark.

The live recovery exposed another race: after a committed approval, a late
stream frame and no-reply handler could overwrite the completed run. The
follow-up fences stream updates at the write and rechecks both run and job
inside retry/exhaustion transactions. Deterministic regression cases simulate
terminal settlement between the initial read and the write; neither streaming,
retry nor exhaustion may revive/fail that completed action. The existing
channel lifecycle suite also passes.

Reviewer run `48e5f168-c150-41ae-9f91-1d9d9deaaafd` was restored from its
committed approval receipt `cmuc0ft1p01kpovuh3i5budyf`. The false timeout remains
in its completion anomaly and an operator-repair audit entry. No task decision
was replayed by that repair.

Late no-reply errors following a committed terminal action are also converted
to a completed UI event, retaining the error as a completion anomaly. The WDT
fixture exercises that real stream callback, as well as deterministic races
for retry, exhaustion and late stream writes. This follow-up changes PM's
server/consumer only; another gateway reload is not needed.
