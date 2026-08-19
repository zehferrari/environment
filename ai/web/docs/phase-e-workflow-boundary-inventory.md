# Phase E workflow boundary inventory

Machine-readable registry: `ai/web/lib/tasks/legacy-workflow-boundary-registry.json`.

Registry shape:

- `schemaVersion`: registry format version used by `scripts/workflow-boundary-test.ts`.
- `kernelInternals[]`: command-kernel/transaction internals that are allowed to mutate workflow-owned rows directly.
- `boundaries[]`: legacy mutation boundaries still allowed during the Phase E drain. Each entry records `id`, `files`, `expectedDirectMutationCounts`, `entryPoints` (file/function boundaries), `triggerSurface`, `currentOwner`, `stateTouched`, `sideEffects`, `phaseEMigrationDestination`, `instrumentation.labels`, `responseParity`, and `sideEffectParity`.

Instrumentation contract: every legacy boundary emits `task.workflow.legacy_boundary.invoked` before its guards and mutation transaction. Its payload contains the injective registry `legacyBoundary` id and `entryPoint`. This counts attempted invocations, including guard rejections and non-transition writers. The activity kind, payload keys, and boundary ids are stable inputs for PHASEE-10 dashboards and the E5 drain report; do not rename them without updating the registry and downstream evidence.

## Registered boundaries

| ID | Current owner | Trigger surface | State touched | Phase E destination | Stable labels |
| --- | --- | --- | --- | --- | --- |
| `agent-task-workflow-route` | PM agent workflow route | Native PM task workflow callback for assignee/reviewer actions | Task status, ActionPlan approval, execution episodes, checklist, blockers, outbox | Task workflow command adapter backed by `submitWorkflowCommand` | `agent-workflow`, `agent-workflow-v2`, `ready-for-review`, `task.workflow.v2_shadow`, `task.workflow.v2_canary` |
| `agent-epic-workflow-route` | PM epic workflow route | Native PM epic workflow callback for completion/deploy review and manager actions | Epic status/deploy fields, child task status, plan reset, task creation, outbox | Epic workflow command adapter plus child-task command dispatch | `completion_review_reject`, `deploy_review_reject`, `epic-manager-workflow` |
| `browser-board-move-actions` | Board server actions + `lib/tasks/move-status.ts` | Browser board drag/drop/status changes | Task status/rank, review completion/finalization state | Board move command adapter | `human-board-move`, `agent-board-move`, `board-move`, `board_move` |
| `task-detail-server-actions` | Task detail page server actions | Task editor status and Action Plan approval actions | Task status and ActionPlan approval/revision fields | Task detail command adapter | `task-edit`, `action-plan-approval`, `task.action_plan.approve` |
| `auto-start-and-queue-refill` | Task auto-start and Epic assignment helpers | Plan approval, Epic open/status changes, dependency completion, workflow nudge | Task status, assignee, approval reset, dependency refill outbox | Prepare/start and dependency-release command adapters | `reviewer-plan-approval`, `agent-action-plan-approval`, `pm-workflow-nudge`, `dependency-completed`, `task.assign` |
| `review-submission-and-validation` | Review handoff/repository validation helpers | `ready_for_review`, verifier callback, branch-pushed verifier utility | Task status, repository run, review run, reporter alert | Submit-candidate procedure and validation callback command | `ready-for-review`, `monitor-repository-validation`, `pm.repo.verify.enqueue`, `pm.repo.verify.operational_error` |
| `review-decision-and-finalization` | Review automation and Epic merge helpers | `review_done`/`review_feedback`, finalization jobs, Epic merge workers | Task status, ReviewRun, TaskRepositoryRun, Epic completion/deploy fields | Review decision command adapter and finalization procedure | `agent-workflow`, `repository-finalization`, `workflow-reconciliation`, `pm.epic.merge.ok` |
| `epic-human-actions` | Epic action helpers | Epic create/update/status/action-plan actions | Epic status/action-plan, child Task status/archive/rank | Epic command adapter with child-task command fanout | `epic_update`, `epic_status`, `epic_open`, `epic.status` |
| `proposal-application` | Work-item proposal apply helpers/API | Approved proposal application | Task/Epic/SubTask creation/update, Task status, proposal status | Proposal command adapter emitting task/epic/subtask commands | `proposal-apply`, `task.create`, `task.update`, `task.subtask.add`, `workitem.proposal.apply` |
| `workflow-reconciler-and-repair-tools` | Workflow reconciler/repair tooling | Monitor reconciliation, outbox drain failures, operator repair scripts | Task status, outbox dispatch, ReviewRun, TaskRepositoryRun, reporter alert | Reconciler/repair command adapter | `workflow-reconciliation`, `workflow_outbox`, `operator-finalization-repair`, `reopen-open-subtasks` |
| `subtask-checklist-actions` | Task checklist helper | PM add/complete/remove checklist actions | SubTask create/update/delete/rank/progress | Checklist command adapter | `task.subtask.add`, `task.subtask.complete`, `task.subtask.delete` |

## File/function coverage

The registry `entryPoints` fields name the concrete functions/actions that currently own each legacy boundary (for example `startApprovedTodoTaskIfIdle`, `assignOpenEpicTasks`, `completeReviewedTaskAndAssignNext`, proposal apply operations, workflow route actions, and operator repair scripts). The freeze test asserts every boundary carries file/function entry-point coverage, emits its own `legacyBoundary` label from a registered file, and preserves the exact detected direct-mutation count per registered file. New writers therefore fail even when added to an already registered file.

## Response and side-effect parity requirements

Command adapters that replace these legacy paths must preserve:

- Existing JSON/form responses, validation errors, redirects, silent/visible PM routing, and episode budget fields.
- Existing authorization and guard behavior, including owner/reviewer/assignee scope, one-active-task checks, Epic status gates, dependency guards, and worktree errors.
- Existing mechanical effects: activity rows, generated comments, Action Plan revision state, checklist minutes/progress, board/cache revalidation, outbox effects, agent wakes, repository validation/finalization jobs, Epic merge/cleanup, blocker settlement, and queue refill.
- Existing idempotency and compare-and-set behavior for transition, review lease, repository run, workflow outbox, and repair paths.

`pnpm test:workflow-boundary` is the freeze gate. It loads the registry, permits only registered legacy files at their frozen direct-mutation counts plus named kernel internals, and proves inline unregistered writer fixtures fail for direct, aliased, and namespaced transition-kernel calls, a direct `Task.status` write, and a direct workflow-cycle write. Product test files using `-test`, `.test`, or `.spec` conventions are explicitly excluded.
