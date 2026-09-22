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
