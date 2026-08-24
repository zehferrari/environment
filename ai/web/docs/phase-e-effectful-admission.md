# Phase E effectful admission and E2 canary

`PM_ORCHESTRATOR_V2_MUTATION_PROJECTS` is the only effectful admission
allowlist. It defaults to empty. `PM_ORCHESTRATOR_V2_SHADOW` and
`PM_ORCHESTRATOR_V2_PROJECTS` remain compute-only comparison flags: changing
either one cannot pin ownership, submit an authoritative command, or start a
procedure.

Durable `Task.workflowEngine` (and the engine copied to an open workflow cycle)
decides the authoritative path. Once a task is pinned to `orchestrator_v2`, a
rejection, replay, stale callback, operational error, or allowlist rollback
never falls through to a legacy mutation.

`PM_PRIVATE_TASK_AGENT_PROJECTS` is a separate, empty-default capability used
only for the private E2 cohort. A project must be named explicitly in both it
and `PM_ORCHESTRATOR_V2_MUTATION_PROJECTS`; wildcards do not count. Access is
limited to top-level, non-Epic, private `orchestrator_v2` tasks and only the
current assignee or resolved reviewer. It applies to exact owner-origin or
audited task workflow turns, callbacks, workflow actions, and scoped task
context. Attachments, project/Epic context, search, generic events, and work
item proposals remain private.

## Operator commands

All commands use the configured `DATABASE_URL`. `admit` and `unpin` require the
active Mission Control owner's username and produce structured ActivityLog
audit rows; they never write user comments.

```bash
pnpm phasee:admission preflight --evidence=/absolute/path/e2-evidence.json
pnpm phasee:admission report --project=synthetic-private-canary
pnpm phasee:admission report --project=production-project --tasks=PROJECT-1,PROJECT-2 --planned
pnpm phasee:admission report --project=production-project --evidence=/absolute/path/e3-evidence.json
pnpm phasee:admission admit --project=synthetic-private-canary --operator=<owner> --evidence=/absolute/path/e2-evidence.json --dry-run
pnpm phasee:admission admit --project=synthetic-private-canary --operator=<owner> --evidence=/absolute/path/e2-evidence.json
pnpm phasee:admission observe --project=production-project --evidence=/absolute/path/e3-evidence.json
pnpm phasee:admission unpin --project=synthetic-private-canary --task=<task-id-or-key> --operator=<owner>
```

Admission evaluates and compare-and-sets each task in its own transaction. It
admits only quiescent Backlog/To Do tasks by default. `--include-done` opts into
Done projection checks. Active cycles, PM execution runs, continuations,
procedures, repository validation/finalization or recovery work, workflow
outbox effects, and unsettled command receipts all produce stable skip reasons.
Repeated or concurrent runs converge on one durable pin and deduplicated audit
evidence.

Production `project_cohort` evidence uses schema version 2 and names the exact
task IDs/keys to inspect and admit. `admit` refuses blank, duplicate, missing,
out-of-project, or same-task-by-id-and-key selectors before any pin. It also
binds every successful pin to the evidence ID, cohort stage, and exact formal
owner authorization comment. Eligible tasks outside that approved set remain
legacy-owned and are listed in the raw admission result.

Before the effectful allowlist changes, `report --planned --tasks=...` performs
the same quiescence checks as admission while explicitly reporting
`configuredEffectful: false` and `inspectionAssumedEffectful: true`. This is a
read-only candidate projection, never an admission bypass. `admit` always
requires the real effectful configuration.

Removing a project from the effectful allowlist stops new pins only. Existing
V2 tasks, cycles, commands, workers, callbacks, and procedures continue under
V2 ownership. `unpin` is a separate owner-only operation and rejects until the
task is quiescent with no unsettled mechanical work.

## Mandatory rollout gate

Copy `docs/phase-e-canary-evidence.example.json` outside the repository and set
a check to `true` only after retaining its command output. Admission fails if
any check or ownership field is incomplete. For E2, the configured mutation
cohort must contain exactly the evidence target slug; wildcard admission is
rejected.

Required evidence:

- disposable-copy migrations, typecheck, aggregate workflow suite, focused
  Phase E suites, production build, and lint;
- procedure-handler idempotency and schema-v2 callback correlation;
- comparison telemetry with no unexplained authorization, guard, or status
  mismatch;
- strict doctor with no blocking invariant;
- named backup, rollback, and on-call owners; and
- retained artifact paths or durable URLs, with no secrets.

`pnpm workflow-doctor --json --strict` exposes configured effectful cohorts,
eligible/admitted/skipped tasks, engine distribution, active procedures,
receipt and callback health, legacy invocations, invariant findings, and a
stable diagnostic for every Phase E stop condition.

## E2 internal canary runbook

1. Validate the clean task baseline against `origin/phase-e`. Publish current
   task work only through the PM `publish_checkpoint` permission flow and let
   configured deployment automation deploy the resulting Epic SHA. Do not
   commit, push, SSH-deploy, or edit a production database manually.
2. Create exactly one synthetic project visible only to the canary operators.
   Create private code and non-code tasks; keep all other tasks legacy-owned.
3. Run the full gate and retain the evidence JSON plus raw outputs. Configure
   both `PM_ORCHESTRATOR_V2_MUTATION_PROJECTS` and
   `PM_PRIVATE_TASK_AGENT_PROJECTS` to the same one explicit slug through the
   normal deployment configuration path. Assign each canary task to its agent
   and set a resolved reviewer before dispatching a turn.
4. Run `report`, then `admit --dry-run`. Confirm only new/quiescent private
   tasks say `would_admit`; every active/public/unsafe task must have a stable
   skip reason. Run `admit` once, then repeat it to prove idempotency.
5. Complete a non-code task through plan, approval, start, review feedback,
   same-evidence resubmission, acceptance, and Done. Complete a code task
   through worktree preparation, validation, review, finalization, cleanup,
   and Done. At every step confirm one engine, one cycle, one receipt, and one
   procedure owner.
6. Run `pnpm test:phasee-11`. It covers durable-boundary crashes, receipt/
   continuation replay, procedure lease recovery, duplicate callback replay,
   exact schema-v2 callback fencing, same-SHA cycles, and absence of diagnostic
   comment spam on disposable databases.
7. On the deployed synthetic tasks, use the configured service automation to
   terminate/restart the procedure worker at preparation, validation callback,
   finalization callback, outbox publication, and successor-dispatch waits.
   Replay the exact command/callback after each restart. Do not repair rows
   directly.
8. While V2 work is In Progress, validating, in Review, and finalizing, remove
   the project slug through configured deployment automation. Verify new tasks
   remain legacy-owned while the already-pinned task finishes through its
   exact V2 procedure/callback path. Re-enable only after the gate is clean.
9. Run admission and doctor reports again. Retain task/cycle/receipt/procedure/
   callback IDs, worker restart timestamps, the deployed Epic SHA, and the raw
   JSON reports in the task's repository evidence file.

Stop new admission immediately if any diagnostic reports a mechanical decision
actor, dual authoritative mutation, missing procedure/continuation, evidence
conflict, stale callback mutation, reused/reset review evidence, duplicate
effect, lost continuation, V2-to-legacy rollback, or engine/cycle/receipt
contradiction. Stopping admission must not stop workers required to finish or
safely surface accepted V2 work.

E2 passes only when the retained evidence shows no invariant violation,
duplicate effect, lost continuation, dual mutation, or manual database repair.

## E3 production canary runbook

1. Start from a clean task branch at the current `origin/phase-e` tip. Verify
   the configured deployment serves that exact Epic SHA; a code-equivalent but
   different SHA is not sufficient evidence. Never SSH-deploy, run Git on the
   target, or mutate the production database.
2. Copy `docs/phase-e-production-cohort-evidence.example.json` outside the
   repository. Retain disposable migrations, typecheck, aggregate workflow,
   focused Phase E, build, lint, comparison, callback-correlation, strict
   doctor, cohort, engine-distribution, and legacy-invocation outputs before
   setting their checks or artifact references.
3. Select one low-risk production project and at most five exact tasks. Run
   `report --planned --tasks=...`; every candidate must be Backlog/To Do (or an
   explicitly requested Done projection) with no active cycle, repository work,
   procedure, PM run, continuation, outbox recovery, or unsettled receipt.
   Preserve the full report so all non-selected tasks are visibly still legacy.
4. Raise one formal `reporter_approval` round on the rollout task. Its scope
   must name the project, exact task IDs/keys, deployed Epic SHA, the independent
   `PM_ORCHESTRATOR_V2_MUTATION_PROJECTS` change, observation minutes, rollback
   action, and Phase E stop conditions. Record the generated authorization
   comment ID, owner username, task ID, and timestamp verbatim. Production
   admission rejects an ordinary or deleted comment, a different operator, or
   a grant whose scope is incomplete.
5. Use configured deployment to add exactly that project to the mutation
   allowlist while keeping the compute-only shadow/project probe independent.
   Wildcard admission and batched project additions fail the gate. Confirm the
   configured deployment serves the recorded Epic SHA.
6. Run `preflight`, exact `report`, and `admit --dry-run`. Compare the raw task
   set to the owner grant, then run `admit` once and replay it to prove
   idempotency. Stop if any selector or safe-state result changed.
7. Exercise review feedback, the same candidate SHA in a later cycle,
   finalization failure/retry, and process restart/recovery. During an active V2
   cycle, remove only the project from the effectful allowlist through configured
   deployment. Confirm new tasks remain legacy while the already-owned cycle
   finishes through its V2 workers, receipts, procedures, and exact callbacks.
   Never use `unpin` for admission rollback.
8. Restore only the owner-approved setting after the rollback proof and keep
   workers required by accepted V2 work running. Retain start/end cohort,
   engine, legacy-counter, callback, receipt/procedure, and strict-doctor JSON.
   `observe` exits successfully only after the declared minimum window has
   elapsed; the retained doctor/counter delta must also show zero unexplained
   mismatch or new legacy bypass.

## E4 controlled project expansion

1. Open one project only after the immediately previous cohort has completed
   its full observation window. Change the evidence stage to
   `e4_project_expansion` and record the previous evidence ID, project,
   completion timestamp, and retained observation artifact.
2. Repeat the E3 baseline, exact safe-task selection, owner approval, configured
   deployment, preflight, dry-run, admission, replay, and observation sequence.
   The before/after mutation setting must preserve every prior explicit project
   and add exactly the one target project; `*`, removals, replacements, and
   multi-project batches fail closed.
3. After every cohort, retain exact engine/cohort visibility and enumerate
   historical legacy-owned cycles, jobs, callbacks, recoveries, continuations,
   and finalization work. These drain under legacy adapters; no new legacy-owned
   mutation may begin in an expanded project.
4. Halt new admission immediately on any strict-doctor, callback-fencing,
   continuation, duplicate-effect, evidence-conflict, legacy-bypass, or
   engine/cycle/receipt regression. Roll back admission only; keep the workers
   needed to finish or safely surface already accepted V2 work.
5. E4 exits only when every active project is explicitly in the effectful
   cohort, all safe-state tasks approved for that round are V2-owned, and every
   remaining legacy owner is named in the retained historical-drain inventory.
