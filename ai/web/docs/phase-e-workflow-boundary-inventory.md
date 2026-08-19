# Phase E workflow boundary inventory

Machine-readable registry: `ai/web/lib/tasks/legacy-workflow-boundary-registry.json`.

Registry shape:

- `schemaVersion`: registry format version used by `scripts/workflow-boundary-test.ts`.
- `kernelInternals[]`: command-kernel/transaction internals that are allowed to mutate workflow-owned rows directly.
- `boundaries[]`: legacy mutation boundaries still allowed during the Phase E drain. Each entry records `id`, `files`, `expectedDirectMutationCounts`, `entryPoints` (file/function boundaries), `triggerSurface`, `currentOwner`, authoritative `actorSource`, `authorizationAndGuards`, `stateTouched`, `sideEffects`, deterministic `idempotencyIdentity`, exact `replacementCommand`, `phaseEMigrationDestination`, `instrumentation.labels`, `responseParity`, and `sideEffectParity`.

Instrumentation contract: every legacy boundary emits `task.workflow.legacy_boundary.invoked` before its guards and mutation transaction. Its payload contains the injective registry `legacyBoundary` id and `entryPoint`. This counts attempted invocations, including guard rejections and non-transition writers. The activity kind, payload keys, and boundary ids are stable inputs for PHASEE-10 dashboards and the E5 drain report; do not rename them without updating the registry and downstream evidence.

## Registered boundaries

| ID | Current owner | Trigger surface | State touched | Phase E destination | Stable labels |
| --- | --- | --- | --- | --- | --- |
| `agent-task-workflow-route` | PM agent workflow route | Native PM task workflow callback for assignee/reviewer actions | Task status, ActionPlan approval, execution episodes, checklist, blockers, outbox | Task workflow command adapter backed by `submitWorkflowCommand` | `agent-workflow`, `agent-workflow-v2`, `ready-for-review`, `task.workflow.v2_shadow`, `task.workflow.v2_canary` |
| `agent-epic-workflow-route` | PM epic workflow route | Native PM epic workflow callback for completion/deploy review and manager actions | Epic status/deploy fields, child task status, plan reset, task creation, outbox | Epic workflow command adapter plus child-task command dispatch | `completion_review_reject`, `deploy_review_reject`, `epic-manager-workflow` |
| `review-submission-and-validation` | Review handoff/repository validation helpers | `ready_for_review`, verifier callback, branch-pushed verifier utility | Task status, repository run, review run, reporter alert | Submit-candidate procedure and validation callback command | `ready-for-review`, `monitor-repository-validation`, `pm.repo.verify.enqueue`, `pm.repo.verify.operational_error` |
| `review-decision-and-finalization` | Review automation and Epic merge helpers | `review_done`/`review_feedback`, finalization jobs, Epic merge workers | Task status, ReviewRun, TaskRepositoryRun, Epic completion/deploy fields | Review decision command adapter and finalization procedure | `agent-workflow`, `repository-finalization`, `workflow-reconciliation`, `pm.epic.merge.ok` |
| `epic-human-actions` | Epic action helpers | Epic create/update/status/action-plan actions | Epic status/action-plan, child Task status/archive/rank | Epic command adapter with child-task command fanout | `epic_update`, `epic_status`, `epic_open`, `epic.status` |
| `proposal-application` | Work-item proposal apply helpers/API | Approved proposal application | Task/Epic/SubTask creation/update, Task status, proposal status | Proposal command adapter emitting task/epic/subtask commands | `proposal-apply`, `task.create`, `task.update`, `task.subtask.add`, `workitem.proposal.apply` |
| `workflow-reconciler-and-repair-tools` | Mechanical reconciler/outbox workers | Monitor reconciliation and recorded durable-effect delivery | Outbox dispatch/requeue, cancellation fences, execution-state/activity escalation projections | Mechanical callback/requeue workers; typed commands for domain repairs | `workflow-reconciliation`, `workflow_outbox`, `task.workflow.effect_failed` |
| `subtask-checklist-actions` | Task checklist helper | PM add/complete/remove checklist actions | SubTask create/update/delete/rank/progress | Checklist command adapter | `task.subtask.add`, `task.subtask.complete`, `task.subtask.delete` |

## File/function coverage

The registry `entryPoints` fields name the concrete functions/actions that currently own each legacy boundary (for example `completeReviewedTaskAndAssignNext`, proposal apply operations, workflow routes, reconciliation, and outbox drain). For every source the registry also names the server-resolved actor, authorization and guard contract, deterministic replay identity, exact replacement command or callback, state writes, synchronous effects, and response contract. The freeze test asserts every boundary carries that adapter contract, emits its own `legacyBoundary` label from a registered file, and preserves the exact detected direct-mutation count per registered file. New writers therefore fail even when added to an already registered file.

The Phase E browser board/task-detail adapters and PM policy automation now submit canonical commands, so they are no longer legacy registry entries. `repair-accepted-finalization.ts` and `reopen-tasks-with-open-subtasks.ts` are read-only evidence/inventory tools. `repair-task-workflow-state.ts` defaults to dry-run and its explicit `--apply` operations are mechanical blocker/session/notification recovery only; it cannot write task workflow-owned fields. The reconciler likewise never manufactures a missing Review-to-Done decision: it reports and escalates that contradiction for an authenticated typed repair command.

## Response and side-effect parity requirements

Command adapters that replace these legacy paths must preserve:

- Existing JSON/form responses, validation errors, redirects, silent/visible PM routing, and episode budget fields.
- Existing authorization and guard behavior, including owner/reviewer/assignee scope, one-active-task checks, Epic status gates, dependency guards, and worktree errors.
- Existing mechanical effects: activity rows, generated comments, Action Plan revision state, checklist minutes/progress, board/cache revalidation, outbox effects, agent wakes, repository validation/finalization jobs, Epic merge/cleanup, blocker settlement, and queue refill.
- Existing idempotency and compare-and-set behavior for transitions, review leases, repository runs, workflow outbox, and mechanical recovery paths.

`pnpm test:workflow-boundary` is the freeze gate. It loads the registry, permits only registered legacy files at their frozen direct-mutation counts plus named kernel internals, and proves inline unregistered writer fixtures fail for direct, aliased, and namespaced transition-kernel calls, a direct `Task.status` write, and a direct workflow-cycle write. Product test files using `-test`, `.test`, or `.spec` conventions are explicitly excluded.
