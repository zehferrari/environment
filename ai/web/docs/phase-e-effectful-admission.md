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

## Operator commands

All commands use the configured `DATABASE_URL`. `admit` and `unpin` require the
active Mission Control owner's username and produce structured ActivityLog
audit rows; they never write user comments.

```bash
pnpm phasee:admission preflight --evidence=/absolute/path/e2-evidence.json
pnpm phasee:admission report --project=synthetic-private-canary
pnpm phasee:admission admit --project=synthetic-private-canary --operator=<owner> --evidence=/absolute/path/e2-evidence.json --dry-run
pnpm phasee:admission admit --project=synthetic-private-canary --operator=<owner> --evidence=/absolute/path/e2-evidence.json
pnpm phasee:admission unpin --project=synthetic-private-canary --task=<task-id-or-key> --operator=<owner>
```

Admission evaluates and compare-and-sets each task in its own transaction. It
admits only quiescent Backlog/To Do tasks by default. `--include-done` opts into
Done projection checks. Active cycles, PM execution runs, continuations,
procedures, repository validation/finalization or recovery work, workflow
outbox effects, and unsettled command receipts all produce stable skip reasons.
Repeated or concurrent runs converge on one durable pin and deduplicated audit
evidence.

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
   `PM_ORCHESTRATOR_V2_MUTATION_PROJECTS` to the one explicit slug through the
   normal deployment configuration path.
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
