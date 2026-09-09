# V23-38 finalization audit — 2026-09-09

Task: [Key element does not match the schema](https://agents.vixi.au/projects/v23/tasks/cmtrzl2edjd5gov2ks78ojgwq).
Evidence: read-only `/srv/Data/pm/wt-main.db` task, activity, procedure, repository,
review and agent-run records; deployed source at `998dae4`; read-only filesystem
ACL and systemd inspection. Times below are Brisbane (AEST), 8 September 2026.

## What happened

The code was accepted, but repository cleanup prevented PM from completing the
task. The final state is **Review**, an **accepted** review lease, repository
phase **operational_error**, and a procedure still **waiting_callback**. The
reporter alert is set; the operational error exists in activity and repository
state. It was not completely invisible, but the terminal explanatory comment
and procedure completion never happened.

| Time | Event and consequence |
| --- | --- |
| 11:50–12:58 | A revised plan lost its reviewer notification, producing a 68-minute wait. See the [earlier audit](v23-38-workflow-2026-09-08.md). |
| 13:00 | Approval and implementation-start handoffs generated redundant wakes and canceled continuing turns. Those fixes are already deployed. |
| 13:53:29 | First submission failed its push: the local branch was behind `origin/greenid-simplekyc` (`ad50aa350e`). Carmen then reconciled the branch and reran validation. |
| 14:26:41 | Reviewer requested real corrections: bind the service bypass to the verified coordinator principal, and test the actual cart entry points, including timeout cleanup. Passing lower-level suites had not proved these requirements. |
| 14:41:17 | PM verified and published candidate `93c6c49c33d41a77c759b454597ad725b61e5ce8`. |
| 14:46:22 | Asdrubal accepted that candidate. PM scheduled `finalize_accepted_review`. |
| 14:46:32 | `worktree-remove` refused cleanup at `orders/vendor` because of permissions. |
| 14:46:38 | The retry was rejected because its repository version no longer matched. No callback completed the waiting step. |

This task accumulated 21 agent runs, five superseded runs and ten episode
records. Its final reviewer dispatch carried 82,846 system-prompt characters;
that is a character count, not a token measurement. There are **zero**
`pm.task.runtime.prepared` events for this task. Its last agent run ended before
the compact runtime activation at 15:16, so this history does not measure the
new runtime's live effectiveness.

## The mechanical defects

The finalization job and its procedure step both stored repository version 29.
On the first operational failure, `recordTaskReviewOperationalError` advanced
the repository row to version 30. `executeFinalizeJob` then enqueued the same
version-29 job. Its exact-correlation preflight correctly rejected the stale
identity; the spool runner treated that rejection as handled and removed the
job. The procedure remained waiting for a callback that would never arrive.

Testing also found that the documented recovery action was denied: the
orchestrator allowed `accept_review` / `review_done` only with an
`awaiting_review` lease, while this task already had an `accepted` lease.
Furthermore, simply allowing the action would reuse the old running procedure
and preserve the stall.

The cleanup failure itself is real. At audit time `orders/vendor` belonged to
`carmen:carmen`. Its `group:code-agents:rwx` ACL was limited by `mask::r-x`, so
other shared-tree users could not write it. The repository runner executes as
`zeh`. Default ACLs were present, but they did not repair this directory's
current ACL mask. The audit does not establish which command changed the mask.
Do not bypass the removal preflight or force-delete the worktree as root.

## Changes on the fix branch

- Pending operational retries still set the reporter alert and record the
  error, but preserve the repository record and version owned by their job.
  Finalization remains in progress until success or bounded exhaustion.
- After three failed runner attempts, PM records the repository operational
  error, emits the explanatory comment and consumes the failure callback.
  The verification step becomes a terminal operational error immediately;
  repeatedly reading the same failed callback cannot repair host permissions.
- The original accepting reviewer, while still authorized as the Done owner,
  can explicitly retry the same accepted candidate in `operational_error`.
  Authorization, guards and transactional lease checks agree. A different
  reviewer, lease or commit cannot use this recovery path.
- Recovery retires failed or stranded finalization procedures in the active
  cycle before scheduling a fresh procedure. The accepted review is retained.
  Late deliveries from the abandoned job remain fenced.
- Finalization failure comments accurately say that the task remains in Review.

No schema migration or gateway-plugin reinstall is required for these changes.
They are application changes; deploy through the usual reviewed merge and
`pm-switch` boundary.

## Recovering this live task after deployment

The audit and implementation do not modify the production database, ACLs,
services or agent conversations. Recovery is a separate live operation:

1. Recheck the task still has the same accepted lease/candidate and that no new
   implementation or finalization has started. Verify local cleanliness and
   remote candidate identity before doing cleanup-related work.
2. Restore the shared code-tree permissions using the documented
   `code-tree-perms` host procedure, preserving configured secret exclusions.
   Inspect both the affected directory and its descendants as the actual
   repository runner user. Re-running an agent will not repair these ACLs.
3. Have the original reviewer submit a **new** authenticated `review_done`
   action for the accepted candidate. Replaying the old command receipt is
   idempotent and will not create recovery work. The repaired orchestrator
   supersedes the old waiting procedure and schedules a fresh exact job.
4. Verify successful cleanup/callback, Review → Done, a closed workflow cycle
   and preserved review attribution. Remote branch publication is preserved;
   this recovery does not merge a pull request.

Do not reset the task to implementation, invalidate its approved code merely
because cleanup failed, edit repository version numbers manually, or disable
callback correlation.

## Further prevention

Keep the already enabled compact runtime, native PM tools and continuation
fixes; measure future eligible runs using the runtime report instead of
attributing this historical run to them. Add a branch-freshness check before
implementation on reused worktrees, so a non-fast-forward problem is detected
before coding. Never automatically reset a dirty or diverged worktree.

Check runner access after dependency installation, because inherited default
ACLs alone do not guarantee that tools preserve writable ACL masks. Review
acceptance should link each requirement to the actual entry point exercised
by a test; generic helper/transport tests did not establish the cart behavior
or trusted service-principal behavior in this incident.

The existing reconciler detects aged `waiting_callback` procedures, but this
task had no later recovery event. A separate operational follow-up should
verify that the scheduled reconciler/watchdog is running and that its alerts
reach the owner; detection alone must not be described as automatic repair.

## Validation

`test:finalization-retry` uses a migrated disposable SQLite database, a local
bare Git remote and linked worktrees. Only the cleanup OS boundary is injected
to simulate permission failure. It exercises the actual finalization executor,
retry spool, exact correlation, callback, procedure runner and workflow command
path. Cases cover transient failure → Done, callback replay without repeated
cleanup, persistent failure with bounded exhaustion, exact reviewer/lease/SHA
recovery, historical missing-callback recovery, and rejection of late or stale
jobs. The suite is included in `test:workflow`.

Validation passed: the full workflow gate (55/55 suites), five focused suites
rerun after the recovery addition, TypeScript checking and lint of touched
files. Temporarily removing the pending-retry fix reproduces the version
identity failure in the new regression; the fixed source was restored.
